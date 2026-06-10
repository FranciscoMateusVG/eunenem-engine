import { SpanStatusCode } from '@opentelemetry/api';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import { UsuarioNaoEncontradoError } from '../../errors/usuario/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';
import type { TutorialStatusResponse } from './tutorial-status-response.js';

/**
 * Plan 0018 Phase A (aperture-omswg). Marks the first-time tutorial as
 * completed for the given Usuario. Idempotent / first-write-wins:
 *   - First call on a NULL state → flips to `completadoEm = agora`,
 *     returns { completado: true, completadoEm: <now> }.
 *   - Subsequent calls → no-op at the SQL layer (the adapter's WHERE
 *     guard skips already-completed rows), returns the persisted
 *     original timestamp (NOT `agora`).
 *
 * The "second call returns the ORIGINAL timestamp" contract matches the
 * banked visitor-side contribuinte-projection pattern (first-writer
 * wins; the second writer's value is silently dropped).
 *
 * Auth gate: NOT enforced here — the caller (tRPC procedure) MUST
 * derive `idUsuario` from the session and never accept it from the
 * client. The use-case still 404s on unknown id so the tRPC layer can
 * surface a useful error code.
 */
export interface MarcarTutorialUsuarioComoCompletadoDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly observability: Observability;
}

export async function marcarTutorialUsuarioComoCompletado(
  deps: MarcarTutorialUsuarioComoCompletadoDeps,
  idUsuario: IdUsuario,
  agora: Date,
): Promise<TutorialStatusResponse> {
  const { usuarioRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('marcarTutorialUsuarioComoCompletado', async (span) => {
    try {
      span.setAttribute('usuario.id', idUsuario);
      const existing = await usuarioRepository.findUsuarioById(idUsuario);
      if (!existing) {
        throw new UsuarioNaoEncontradoError(idUsuario);
      }

      // First-write-wins: if already completed, return the persisted
      // timestamp without firing a redundant UPDATE.
      if (existing.tutorialCompletadoEm !== null) {
        span.setAttribute('tutorial.idempotent', true);
        span.setStatus({ code: SpanStatusCode.OK });
        return {
          completado: true,
          completadoEm: existing.tutorialCompletadoEm.toISOString(),
        };
      }

      await usuarioRepository.marcarTutorialCompletado(idUsuario, agora);

      // Re-read to surface the persisted timestamp (defensive — the
      // adapter's `WHERE tutorial_completado_em IS NULL` guard makes
      // double-write impossible, but a stronger contract is "always
      // return what's persisted, not what the caller supplied").
      const updated = await usuarioRepository.findUsuarioById(idUsuario);
      const persistido = updated?.tutorialCompletadoEm ?? agora;

      logger.info('usuario.tutorial.completado', {
        idUsuario,
        completadoEm: persistido.toISOString(),
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return {
        completado: true,
        completadoEm: persistido.toISOString(),
      };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
