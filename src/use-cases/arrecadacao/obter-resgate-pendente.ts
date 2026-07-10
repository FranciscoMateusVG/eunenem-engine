import { SpanStatusCode } from '@opentelemetry/api';
import type { ResgatePendenteRepository } from '../../adapters/arrecadacao/resgate-pendente-repository.js';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';

export interface ObterResgatePendenteDeps {
  readonly resgatePendenteRepository: ResgatePendenteRepository;
  readonly observability: Observability;
}

/**
 * Read the campanha's "resgate pendente" marker (aperture-kj9el #4b). Returns
 * `null` when no marker exists (the admin either never asked to fill later or
 * has since completed the campanha's receiving data, which clears it). Auth
 * is NOT enforced here — the tRPC procedure resolves + authorizes the
 * campanha and passes its id in.
 */
export async function obterResgatePendente(
  deps: ObterResgatePendenteDeps,
  idCampanha: IdCampanha,
): Promise<Date | null> {
  const { resgatePendenteRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterResgatePendente', async (span) => {
    try {
      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      const pendenteDesde = await resgatePendenteRepository.obterPendenteDesde(idCampanha);
      span.setStatus({ code: SpanStatusCode.OK });
      return pendenteDesde;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
