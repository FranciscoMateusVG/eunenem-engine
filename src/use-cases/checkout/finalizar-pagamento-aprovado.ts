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
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import type { Observability } from '../../observability/observability.js';
import { registrarEfeitosFinanceirosPagamentoAprovado } from '../financeiro/registrar-efeitos-financeiros-pagamento-aprovado.js';
import { aprovarPagamento } from '../pagamentos/aprovar-pagamento.js';

export const FinalizarPagamentoAprovadoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
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
 * o workflow — aprova o Pagamento e dispara os efeitos financeiros (saldo
 * + receita) em Financeiro. Distinct from a Saga: não está desfazendo nada;
 * está propagando uma transição.
 *
 * Cross-BC context: Pagamentos não conhece `idCampanha` nem `idPlataforma`
 * (isolamento de BC). O process manager carrega Contribuicao → Campanha
 * para juntar os identificadores, e estampa `idPlataforma` no span/log
 * para rastreabilidade.
 *
 * Carries no compensation: por design, este é o "ponto sem retorno" do
 * fluxo de checkout. Refunds são uma operação separada (fora de escopo).
 *
 * **Idempotency contract:** calling this twice with the same `idPagamento`
 * produces the SAME `{pagamento, lancamentos}` result — exactly one set of
 * Financeiro effects exists per pagamento, no matter how many times the
 * caller retries. Two replay paths are handled:
 *   1. Pagamento already `aprovado` → skip provider call, reuse existing state.
 *   2. Financeiro lancamentos already exist → skip register, return existing.
 * Concurrency safety (two parallel callers) is deferred — needs Postgres
 * row locks or `INSERT ... ON CONFLICT`.
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

      // step 1: approve via Pagamentos — with idempotent replay
      // ----------------------------------------------------------
      // If the Pagamento is already `aprovado` (this is a retry), skip the
      // provider call entirely and reuse the existing state. Anything other
      // than `pendente` or `aprovado` (e.g. `rejeitado`, or missing) goes
      // through the normal aprovarPagamento path so the right typed error
      // is thrown.
      const existingPagamento = await pagamentoRepository.findById(parsed.idPagamento);
      let aprovado: Pagamento;
      if (existingPagamento?.status === 'aprovado') {
        aprovado = existingPagamento;
        logger.info('checkout.pagamento.replay_aprovacao', { idPagamento: parsed.idPagamento });
      } else if (existingPagamento && existingPagamento.status !== 'pendente') {
        throw new PagamentoTransicaoStatusInvalidaError(
          existingPagamento.id,
          existingPagamento.status,
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
      // step has already run on a previous invocation. Return the existing
      // rows instead of attempting a second insert (which would throw
      // FinanceiroPagamentoJaRegistradoError).
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
