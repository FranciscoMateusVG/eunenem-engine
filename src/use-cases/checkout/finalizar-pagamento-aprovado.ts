import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { LivroFinanceiroRepository } from '../../adapters/financeiro/livro-repository.js';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoProvider } from '../../adapters/pagamentos/provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { LancamentoFinanceiro } from '../../domain/financeiro/entities/lancamento-financeiro.js';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import { IdPagamentoSchema } from '../../domain/pagamentos/value-objects/ids.js';
import { DadosContribuinteSchema } from '../../domain/pagamentos/value-objects/dados-contribuinte.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import type { Observability } from '../../observability/observability.js';
import { aprovarPagamento } from '../pagamentos/aprovar-pagamento.js';
import { registrarEfeitosFinanceirosPagamentoAprovado } from '../financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';

export const FinalizarPagamentoAprovadoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
  /**
   * Plan 0015 (aperture-ucgok). Contribuinte snapshot delivered by the
   * payment provider in the webhook event. For Stripe this comes from
   * `checkout.session.completed`'s `custom_fields` (nome + mensagem)
   * + `customer_details` (email). The use-case writes it to
   * `IntencaoPagamento.contribuinte` atomically with the status flip
   * — the per-pagamento snapshot model under plan 0015 (each gift
   * attempt carries its own contribuinte; the contribuição aggregate
   * holds none).
   *
   * Optional: retry paths can fire this use-case without the
   * contribuinte (e.g. replay after the contribuinte was already
   * written on a prior attempt); the existing
   * `IntencaoPagamento.contribuinte` is preserved in that case.
   */
  contribuinte: DadosContribuinteSchema.optional(),
});

export type FinalizarPagamentoAprovadoInput = z.infer<typeof FinalizarPagamentoAprovadoInputSchema>;

export interface FinalizarPagamentoAprovadoResult {
  readonly pagamento: Pagamento;
  readonly lancamentos: readonly LancamentoFinanceiro[];
}

export interface FinalizarPagamentoAprovadoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly campanhaRepository: CampanhaRepository;
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Process Manager: depois que o provedor responde, este orquestrador *avança*
 * o workflow — aprova o Pagamento, persiste o contribuinte na intencao,
 * e dispara os efeitos financeiros (saldo + receita + passthrough).
 *
 * **Plan 0015 (aperture-ucgok).** Two structural changes from pre-collapse:
 *
 * 1. **Contribuinte writes happen here, on the pagamento.** The old
 *    saga had a separate `associarContribuinteContribuicao` step that
 *    flipped the contribuição's status field. With status gone,
 *    contribuinte lives on `IntencaoPagamento` and gets stamped at
 *    finalize time alongside the status transition.
 *
 * 2. **5-state FSM (`pendente | processing | aprovado | rejeitado |
 *    estornado`).** Both `pendente` and `processing` are valid source
 *    states for the aprovado transition — card flows skip processing
 *    (charge.succeeded fires from pendente directly); pix flows transit
 *    through processing (payment_intent.processing → charge.succeeded).
 *    Idempotent on aprovado (replay path).
 *
 * **Idempotency contract:**
 *   1. Pagamento already `aprovado` → skip provider call, reuse state.
 *      The contribuinte is preserved (no overwrite on retry; the
 *      Stripe-provided value won the first time it ran).
 *   2. Lancamentos already exist → skip register, return existing.
 *   3. Pagamento in `rejeitado` or `estornado` → throw transition error.
 */
export async function finalizarPagamentoAprovado(
  deps: FinalizarPagamentoAprovadoDeps,
  input: FinalizarPagamentoAprovadoInput,
): Promise<FinalizarPagamentoAprovadoResult> {
  const {
    pagamentoRepository,
    pagamentoProvider,
    pagamentoEventPublisher,
    contribuicaoRepository,
    campanhaRepository,
    livroFinanceiroRepository,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('finalizarPagamentoAprovado', async (span) => {
    try {
      const parsed = FinalizarPagamentoAprovadoInputSchema.parse(input);
      span.setAttribute('checkout.pagamento.id', parsed.idPagamento);

      // step 0 (plan 0015): contribuinte write — must happen BEFORE the
      // aprovar step so the persisted Pagamento snapshot reflects both
      // the new status AND the new contribuinte in a single update().
      const existingPagamento = await pagamentoRepository.findById(parsed.idPagamento);
      if (existingPagamento && parsed.contribuinte && existingPagamento.intencao.contribuinte === null) {
        // Only write when (a) we have a contribuinte AND (b) the
        // pagamento doesn't already have one (preserves first-writer
        // wins on retry; matches the existing pi/ch external-ref shape).
        const withContribuinte: Pagamento = {
          ...existingPagamento,
          intencao: {
            ...existingPagamento.intencao,
            contribuinte: parsed.contribuinte,
          },
          atualizadoEm: clock(),
        };
        await pagamentoRepository.update(withContribuinte);
        logger.info('checkout.pagamento.contribuinte_stamped', {
          idPagamento: parsed.idPagamento,
        });
      }

      // step 1: approve via Pagamentos — with idempotent replay
      // ----------------------------------------------------------
      // If already aprovado, skip the provider call. Both `pendente`
      // AND `processing` are valid source states for the aprovado
      // transition (plan 0015 5-state FSM); anything else throws.
      const refreshed = await pagamentoRepository.findById(parsed.idPagamento);
      let aprovado: Pagamento;
      if (refreshed?.status === 'aprovado') {
        aprovado = refreshed;
        logger.info('checkout.pagamento.replay_aprovacao', { idPagamento: parsed.idPagamento });
      } else if (
        refreshed &&
        refreshed.status !== 'pendente' &&
        refreshed.status !== 'processing'
      ) {
        throw new PagamentoTransicaoStatusInvalidaError(
          refreshed.id,
          refreshed.status,
          'aprovado',
        );
      } else {
        aprovado = await aprovarPagamento(
          {
            pagamentoRepository,
            pagamentoProvider,
            pagamentoEventPublisher,
            clock,
            observability,
          },
          { idPagamento: parsed.idPagamento },
        );
      }

      // step 2: cross-BC context — Contribuicao → Campanha → idPlataforma
      const idContribuicao = aprovado.intencao.idContribuicao;
      const contribuicao = await contribuicaoRepository.findById(idContribuicao);
      if (!contribuicao) {
        throw new ArrecadacaoContribuicaoNaoEncontradaError(idContribuicao);
      }

      const campanha = await campanhaRepository.findById(contribuicao.idCampanha);
      if (!campanha) {
        throw new ArrecadacaoCampanhaNaoEncontradaError(contribuicao.idCampanha);
      }

      span.setAttribute('checkout.contribuicao.id', idContribuicao);
      span.setAttribute('checkout.campanha.id', campanha.id);
      span.setAttribute('checkout.plataforma.id', campanha.idPlataforma);

      // step 3: register Financeiro effects — with idempotent replay
      // ------------------------------------------------------------
      // If lancamentos for this Pagamento already exist, the Financeiro
      // step has already run on a previous invocation. Return the
      // existing rows instead of attempting a second insert.
      //
      // Plan 0015: drop `metodo` from the input — Financeiro no longer
      // needs it (no more `calcularMaturaEm`); lancamentos start with
      // both date columns null.
      const existingLancamentos = await livroFinanceiroRepository.findLancamentosByIdPagamento(
        aprovado.id,
      );
      let lancamentos: readonly LancamentoFinanceiro[];
      if (existingLancamentos.length > 0) {
        lancamentos = existingLancamentos;
        logger.info('checkout.pagamento.replay_financeiro', {
          idPagamento: aprovado.id,
          lancamentosCount: lancamentos.length,
        });
      } else {
        lancamentos = await registrarEfeitosFinanceirosPagamentoAprovado(
          { livroFinanceiroRepository, clock, observability },
          {
            idPagamento: aprovado.id,
            idContribuicao,
            idCampanha: campanha.id,
            statusPagamento: 'aprovado',
            composicaoValores: aprovado.intencao.composicaoValores,
          },
        );
      }

      logger.info('checkout.pagamento.finalizado', {
        idPlataforma: campanha.idPlataforma,
        idCampanha: campanha.id,
        idContribuicao,
        idPagamento: aprovado.id,
        totalPaidCents: aprovado.intencao.composicaoValores.totalPaidCents,
        receiverAmountCents: aprovado.intencao.composicaoValores.receiverAmountCents,
        platformRevenueAmountCents: aprovado.intencao.composicaoValores.feeAmountCents,
        lancamentosCount: lancamentos.length,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { pagamento: aprovado, lancamentos };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
