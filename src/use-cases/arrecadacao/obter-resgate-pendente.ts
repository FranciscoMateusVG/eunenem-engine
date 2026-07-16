import { SpanStatusCode } from '@opentelemetry/api';
import type { RecebedorRepository } from '../../adapters/arrecadacao/recebedor-repository.js';
import type { ResgatePendenteRepository } from '../../adapters/arrecadacao/resgate-pendente-repository.js';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';

export interface ObterResgatePendenteDeps {
  readonly resgatePendenteRepository: ResgatePendenteRepository;
  readonly recebedorRepository: RecebedorRepository;
  readonly observability: Observability;
}

/**
 * Read the campanha's "resgate pendente" marker (aperture-kj9el #4b). Returns
 * `null` when no marker exists.
 *
 * aperture-4du7r — the marker is the "preencher depois / é para um amigo"
 * defer-intent, set with NO bank data yet (it creates no recebedor row). It is
 * meaningful ONLY while the campanha has no receiving data. Once an ACTIVE
 * recebedor exists (bank data saved), the marker is stale — the save path
 * clears it, but a marker that survived (clear that didn't run, a marker set
 * after the save, or seed data) would otherwise nag "complete seus dados" on a
 * fully-configured account (Thacy's false banner). So we suppress it whenever
 * the campanha already has an active recebedor: a marker + complete data is
 * always stale. A genuinely-deferred campanha has no active recebedor, so its
 * banner still shows correctly. Auth is NOT enforced here — the tRPC procedure
 * resolves + authorizes the campanha and passes its id in.
 */
export async function obterResgatePendente(
  deps: ObterResgatePendenteDeps,
  idCampanha: IdCampanha,
): Promise<Date | null> {
  const { resgatePendenteRepository, recebedorRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterResgatePendente', async (span) => {
    try {
      span.setAttribute('arrecadacao.campanha.id', idCampanha);
      const pendenteDesde = await resgatePendenteRepository.obterPendenteDesde(idCampanha);
      if (pendenteDesde === null) {
        span.setStatus({ code: SpanStatusCode.OK });
        return null;
      }
      // A marker exists — but if the campanha already has receiving data, the
      // marker is stale and must not surface (aperture-4du7r false-positive).
      const recebedorAtivo = await recebedorRepository.findAtivoByCampanhaId(idCampanha);
      const dadosCompletos = recebedorAtivo !== undefined && recebedorAtivo !== null;
      span.setAttribute('arrecadacao.resgate_pendente.suprimido_por_dados', dadosCompletos);
      span.setStatus({ code: SpanStatusCode.OK });
      return dadosCompletos ? null : pendenteDesde;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
