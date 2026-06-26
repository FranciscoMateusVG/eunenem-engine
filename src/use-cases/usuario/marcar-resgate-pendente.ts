import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ResgatePendenteRepository } from '../../adapters/usuario/resgate-pendente-repository.js';
import { IdUsuarioSchema } from '../../domain/usuario/value-objects/ids.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Input for the "resgate pendente" marker (aperture-kj9el #4b). Only the
 * caller's id is needed — no bank data is involved; this records the intent
 * to fill it in later ("preencher depois / estou fazendo para um amigo").
 */
export const MarcarResgatePendenteInputSchema = z.object({
  idUsuario: IdUsuarioSchema,
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
 * Record (upsert) the caller's "resgate pendente" marker (1:1 with Usuario).
 * `pendente_desde` and `criado_em` are both stamped with `clock()`. Auth is
 * NOT enforced here — the tRPC procedure derives `idUsuario` from the session
 * and passes it in (keeps the use-case unit-testable). Invalid input →
 * `UsuarioInputInvalidoError` (mapped to BAD_REQUEST by the router).
 *
 * The marker is CLEARED when the user later saves full receiving data — see
 * `salvarDadosRecebimentoUsuario`.
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
        throw new UsuarioInputInvalidoError(message);
      }

      const { idUsuario } = parsed.data;
      span.setAttribute('usuario.id', idUsuario);

      const now = clock();
      await resgatePendenteRepository.marcarPendente(idUsuario, now, now);

      logger.info('usuario.resgate_pendente.marcado', { idUsuario });
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
