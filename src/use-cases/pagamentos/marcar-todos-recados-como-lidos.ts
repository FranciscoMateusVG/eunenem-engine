import { SpanStatusCode } from '@opentelemetry/api';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';

/**
 * aperture-16wrk / 5v766 Phase A — batch mark-as-read.
 *
 * Single SQL UPDATE with the visitor-mural filter set + the
 * mensagem_lida_em-IS-NULL guard. Already-read recados are
 * untouched. Returns the count flipped for the frontend toast
 * ("N recados marcadas como lidas"). Zero is a normal outcome.
 *
 * Auth: NOT enforced here — caller MUST resolve slug → campanha and
 * verify the session user is an admin BEFORE calling.
 */
export interface MarcarTodosRecadosComoLidosDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly observability: Observability;
}

export interface MarcarTodosRecadosComoLidosResult {
  readonly marcadas: number;
}

export async function marcarTodosRecadosComoLidos(
  deps: MarcarTodosRecadosComoLidosDeps,
  idCampanha: IdCampanha,
  agora: Date,
): Promise<MarcarTodosRecadosComoLidosResult> {
  const { pagamentoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('marcarTodosRecadosComoLidos', async (span) => {
    try {
      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      const marcadas = await pagamentoRepository.marcarTodosRecadosLidos(
        idCampanha,
        agora,
      );
      span.setAttribute('arrecadacao.mensagens.marcadas', marcadas);
      span.setStatus({ code: SpanStatusCode.OK });
      return { marcadas };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
