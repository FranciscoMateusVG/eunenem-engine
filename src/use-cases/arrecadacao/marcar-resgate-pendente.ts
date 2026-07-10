import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ResgatePendenteRepository } from '../../adapters/arrecadacao/resgate-pendente-repository.js';
import { IdCampanhaSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoInputInvalidoError } from '../../errors/arrecadacao/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Input for the "resgate pendente" marker (aperture-kj9el #4b). Only the
 * campanha's id is needed — no bank data is involved; this records the intent
 * to fill it in later ("preencher depois / estou fazendo para um amigo").
 */
export const MarcarResgatePendenteInputSchema = z.object({
  idCampanha: IdCampanhaSchema,
});

export type MarcarResgatePendenteInput = z.infer<typeof MarcarResgatePendenteInputSchema>;

export interface MarcarResgatePendenteResult {
  readonly pendenteDesde: Date;
}

export interface MarcarResgatePendenteDeps {
  readonly resgatePendenteRepository: ResgatePendenteRepository;
  readonly observability: Observability;
  readonly clock: () => Date;
}

/**
 * Record (upsert) the campanha's "resgate pendente" marker (1:1 with
 * Campanha). `pendente_desde` and `criado_em` are both stamped with
 * `clock()`. Auth is NOT enforced here — the tRPC procedure resolves +
 * authorizes the campanha and passes its id in (keeps the use-case
 * unit-testable). Invalid input → `ArrecadacaoInputInvalidoError` (mapped to
 * BAD_REQUEST by the router).
 *
 * The marker is CLEARED when the campanha's recebedor is later saved — see
 * `criarRecebedorParaCampanha`/`alterarDadosRecebedorCampanha`.
 */
export async function marcarResgatePendente(
  deps: MarcarResgatePendenteDeps,
  input: MarcarResgatePendenteInput,
): Promise<MarcarResgatePendenteResult> {
  const { resgatePendenteRepository, observability, clock } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('marcarResgatePendente', async (span) => {
    try {
      const parsed = MarcarResgatePendenteInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new ArrecadacaoInputInvalidoError(message);
      }

      const { idCampanha } = parsed.data;
      span.setAttribute('arrecadacao.campanha.id', idCampanha);

      const now = clock();
      await resgatePendenteRepository.marcarPendente(idCampanha, now, now);

      logger.info('arrecadacao.resgate_pendente.marcado', { idCampanha });
      span.setStatus({ code: SpanStatusCode.OK });
      return { pendenteDesde: now };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
