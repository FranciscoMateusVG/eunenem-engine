import { SpanStatusCode } from '@opentelemetry/api';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import { UsuarioNaoEncontradoError } from '../../errors/usuario/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';
import type { TutorialStatusResponse } from './tutorial-status-response.js';

/**
 * Plan 0018 Phase A (aperture-omswg). Returns the first-time tutorial
 * status for the given Usuario. Pure read.
 *
 * Auth gate: NOT enforced here — the caller (tRPC procedure) MUST
 * derive `idUsuario` from the session and never accept it from the
 * client. Treating it as input here keeps the use-case unit-testable
 * without a session fixture.
 */
export interface ObterStatusTutorialUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly observability: Observability;
}

export async function obterStatusTutorialUsuario(
  deps: ObterStatusTutorialUsuarioDeps,
  idUsuario: IdUsuario,
): Promise<TutorialStatusResponse> {
  const { usuarioRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('obterStatusTutorialUsuario', async (span) => {
    try {
      span.setAttribute('usuario.id', idUsuario);
      const usuario = await usuarioRepository.findUsuarioById(idUsuario);
      if (!usuario) {
        throw new UsuarioNaoEncontradoError(idUsuario);
      }
      const ts = usuario.tutorialCompletadoEm;
      const response: TutorialStatusResponse = {
        completado: ts !== null,
        completadoEm: ts !== null ? ts.toISOString() : null,
      };
      span.setStatus({ code: SpanStatusCode.OK });
      return response;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
