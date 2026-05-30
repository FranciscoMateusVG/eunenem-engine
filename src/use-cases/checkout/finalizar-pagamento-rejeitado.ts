import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { CampanhaRepository } from '../../adapters/arrecadacao/campanha-repository.js';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoProvider } from '../../adapters/pagamentos/provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import { IdPagamentoSchema } from '../../domain/pagamentos/value-objects/ids.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoJaDisponivelError } from '../../errors/arrecadacao/contribuicao-ja-disponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import type { Observability } from '../../observability/observability.js';
import { desassociarContribuinteContribuicao } from '../arrecadacao/desassociar-contribuinte-contribuicao.js';
import { rejeitarPagamento } from '../pagamentos/rejeitar-pagamento.js';

export const FinalizarPagamentoRejeitadoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
});

export type FinalizarPagamentoRejeitadoInput = z.infer<
  typeof FinalizarPagamentoRejeitadoInputSchema
>;

export interface FinalizarPagamentoRejeitadoResult {
  readonly pagamento: Pagamento;
}

export interface FinalizarPagamentoRejeitadoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly campanhaRepository: CampanhaRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Process Manager: depois que o provedor responde com rejeição, este
 * orquestrador *avança* o workflow — rejeita o Pagamento e **compensa** a
 * reserva feita no checkout, devolvendo a Contribuicao ao estado `disponivel`.
 *
 * Symmetric counterpart to `finalizarPagamentoAprovado`: o aprovado dispara
 * efeitos financeiros; o rejeitado libera o claim de Arrecadação. Em nenhum
 * dos dois casos a BC de Pagamentos conhece Contribuicao/Campanha — o
 * process manager faz a costura cross-BC.
 *
 * Cross-BC context: Pagamentos não conhece `idCampanha` nem `idPlataforma`
 * (isolamento de BC). O process manager carrega Contribuicao → Campanha
 * para juntar os identificadores e estampar `idPlataforma` no span/log
 * para rastreabilidade.
 *
 * **Idempotency contract:** calling this twice with the same `idPagamento`
 * produces the SAME `{pagamento}` result — exactly one rejection happens,
 * exatamente um release de claim acontece, no matter how many times the
 * caller retries. Two replay paths are handled:
 *   1. Pagamento already `rejeitado` → skip provider call, reuse existing state.
 *   2. Contribuicao already `disponivel` → swallow
 *      `ArrecadacaoContribuicaoJaDisponivelError` (a "nothing to do" signal,
 *      not a real error) and continue.
 * Concurrency safety (two parallel callers) is deferred — needs Postgres
 * row locks or `INSERT ... ON CONFLICT`.
 */
export async function finalizarPagamentoRejeitado(
  deps: FinalizarPagamentoRejeitadoDeps,
  input: FinalizarPagamentoRejeitadoInput,
): Promise<FinalizarPagamentoRejeitadoResult> {
  const {
    pagamentoRepository,
    pagamentoProvider,
    pagamentoEventPublisher,
    contribuicaoRepository,
    campanhaRepository,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('finalizarPagamentoRejeitado', async (span) => {
    try {
      const parsed = FinalizarPagamentoRejeitadoInputSchema.parse(input);
      span.setAttribute('checkout.pagamento.id', parsed.idPagamento);

      // step 1: reject via Pagamentos — with idempotent replay
      // ----------------------------------------------------------
      // If the Pagamento is already `rejeitado` (this is a retry), skip the
      // provider call entirely and reuse the existing state. Anything other
      // than `pendente` or `rejeitado` (e.g. `aprovado`, or missing) goes
      // through the normal rejeitarPagamento path so the right typed error
      // is thrown.
      const existingPagamento = await pagamentoRepository.findById(parsed.idPagamento);
      let rejeitado: Pagamento;
      if (existingPagamento?.status === 'rejeitado') {
        rejeitado = existingPagamento;
        logger.info('checkout.pagamento.replay_rejeicao', { idPagamento: parsed.idPagamento });
      } else if (existingPagamento && existingPagamento.status !== 'pendente') {
        throw new PagamentoTransicaoStatusInvalidaError(
          existingPagamento.id,
          existingPagamento.status,
          'rejeitado',
        );
      } else {
        rejeitado = await rejeitarPagamento(
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
      const idContribuicao = rejeitado.intencao.idContribuicao;
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

      // step 3: release the Arrecadação claim — with idempotent replay
      // ------------------------------------------------------------
      // If the Contribuicao is already `disponivel`, the compensation has
      // already run on a previous invocation. desassociarContribuinte throws
      // ArrecadacaoContribuicaoJaDisponivelError in that case, which is a
      // "nothing to do" signal — swallow it and continue.
      try {
        await desassociarContribuinteContribuicao(
          { contribuicaoRepository, observability },
          { idContribuicao },
        );
      } catch (compensationError) {
        if (!(compensationError instanceof ArrecadacaoContribuicaoJaDisponivelError)) {
          throw compensationError;
        }
        logger.info('checkout.pagamento.replay_liberacao_claim', {
          idPagamento: rejeitado.id,
          idContribuicao,
        });
      }

      logger.info('checkout.pagamento.rejeitado_finalizado', {
        idPlataforma: campanha.idPlataforma,
        idCampanha: campanha.id,
        idContribuicao,
        idPagamento: rejeitado.id,
        amountCents: rejeitado.intencao.amountCents,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { pagamento: rejeitado };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
