import { SpanStatusCode } from '@opentelemetry/api';
import type { PendenciasDesativacaoRepository } from '../../adapters/usuario/pendencias-desativacao.js';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import { ContaComPendenciasFinanceirasError } from '../../errors/usuario/conta-com-pendencias.error.js';
import { UsuarioNaoEncontradoError } from '../../errors/usuario/nao-encontrado.error.js';
import type { Observability } from '../../observability/observability.js';

export interface DesativarContaUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly pendenciasRepository: PendenciasDesativacaoRepository;
  readonly observability: Observability;
}

/**
 * Soft-disables an account without deleting campaigns or financial history.
 * First-write-wins so retries preserve the original deactivation timestamp.
 * Refused while any campaign the account owns still has money to withdraw or
 * a withdrawal in flight (aperture-851nu). The repository also revokes every
 * session of the user.
 */
export async function desativarContaUsuario(
  deps: DesativarContaUsuarioDeps,
  idUsuario: IdUsuario,
  agora: Date,
): Promise<{ readonly desativadoEm: string }> {
  const { usuarioRepository, pendenciasRepository, observability } = deps;

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

      const pendencias = await pendenciasRepository.listarPendencias(existing.idConta);
      if (pendencias.length > 0) {
        span.setAttribute('usuario.desativacao.pendencias', pendencias.join(','));
        observability.logger.info('usuario.conta.desativacao_bloqueada', { idUsuario, pendencias });
        throw new ContaComPendenciasFinanceirasError(pendencias);
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
