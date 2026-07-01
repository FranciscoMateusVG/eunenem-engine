import { SpanStatusCode } from '@opentelemetry/api';
import type { ResgatePendenteRepository } from '../../adapters/usuario/resgate-pendente-repository.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';

export interface ObterResgatePendenteDeps {
  readonly resgatePendenteRepository: ResgatePendenteRepository;
  readonly observability: Observability;
}

/**
 * Read the caller's "resgate pendente" marker (aperture-kj9el #4b). Returns
 * `null` when no marker exists (the user either never asked to fill later or
 * has since completed their receiving data, which clears it). Auth is NOT
 * enforced here — the tRPC procedure derives `idUsuario` from the session.
 */
export async function obterResgatePendente(
  deps: ObterResgatePendenteDeps,
  idUsuario: IdUsuario,
): Promise<Date | null> {
  const { resgatePendenteRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterResgatePendente', async (span) => {
    try {
      span.setAttribute('usuario.id', idUsuario);
      const pendenteDesde = await resgatePendenteRepository.obterPendenteDesde(idUsuario);
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
