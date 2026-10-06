import { SpanStatusCode } from '@opentelemetry/api';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import { UsuarioNaoEncontradoError } from '../../errors/usuario/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export interface DesativarContaUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly observability: Observability;
}

/**
 * Soft-disables an account without deleting campaigns or financial history.
 * First-write-wins so retries preserve the original deactivation timestamp.
 */
export async function desativarContaUsuario(
  deps: DesativarContaUsuarioDeps,
  idUsuario: IdUsuario,
  agora: Date,
): Promise<{ readonly desativadoEm: string }> {
  const { usuarioRepository, observability } = deps;

  return observability.tracer.startActiveSpan('desativarContaUsuario', async (span) => {
    try {
      span.setAttribute('usuario.id', idUsuario);
      const existing = await usuarioRepository.findUsuarioById(idUsuario);
      if (!existing) throw new UsuarioNaoEncontradoError(idUsuario);

      if (existing.desativadoEm) {
        span.setAttribute('usuario.desativacao.idempotent', true);
        span.setStatus({ code: SpanStatusCode.OK });
        return { desativadoEm: existing.desativadoEm.toISOString() };
      }

      await usuarioRepository.desativarConta(idUsuario, agora);
      const persisted = await usuarioRepository.findUsuarioById(idUsuario);
      if (!persisted?.desativadoEm) throw new UsuarioNaoEncontradoError(idUsuario);

      observability.logger.info('usuario.conta.desativada', {
        idUsuario,
        desativadoEm: persisted.desativadoEm.toISOString(),
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return { desativadoEm: persisted.desativadoEm.toISOString() };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
