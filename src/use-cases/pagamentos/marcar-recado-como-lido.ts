import { SpanStatusCode } from '@opentelemetry/api';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { IdPagamento } from '../../domain/pagamentos/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';

/**
 * aperture-16wrk / 5v766 Phase A — single mark-as-read.
 *
 * Idempotent / first-write-wins: the adapter's `WHERE
 * mensagem_lida_em IS NULL` guard ensures a second call returns the
 * ORIGINAL timestamp (not `agora`). Frontend can fire-and-forget on
 * every "MARCAR LIDA" click without race concerns.
 *
 * Throws `PagamentoNaoEncontradoError` (bubbles via the adapter) when
 * the id is unknown. The tRPC procedure surfaces this as NOT_FOUND.
 *
 * Auth: NOT enforced here — caller MUST verify the pagamento belongs
 * to the session admin's campanha BEFORE calling. The tRPC procedure
 * does this by resolving slug → campanha → fetching the pagamento +
 * cross-checking `intencao.idCampanha`.
 */
export interface MarcarRecadoComoLidoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly observability: Observability;
}

export interface MarcarRecadoComoLidoResult {
  readonly lidaEm: string;
}

export async function marcarRecadoComoLido(
  deps: MarcarRecadoComoLidoDeps,
  idPagamento: IdPagamento,
  agora: Date,
): Promise<MarcarRecadoComoLidoResult> {
  const { pagamentoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('marcarRecadoComoLido', async (span) => {
    try {
      span.setAttribute('pagamento.id', idPagamento);
      const lidaEm = await pagamentoRepository.marcarRecadoLido(idPagamento, agora);
      span.setStatus({ code: SpanStatusCode.OK });
      return { lidaEm: lidaEm.toISOString() };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
