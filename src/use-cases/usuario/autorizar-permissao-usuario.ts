import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { AuthService } from '../../adapters/usuario/auth-service.js';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import { contaTemPermissao } from '../../domain/usuario/entities/usuario.js';
import { PermissaoSchema } from '../../domain/usuario/value-objects/permissao.js';
import { TokenSessaoSchema } from '../../domain/usuario/value-objects/token-sessao.js';
import { UsuarioNaoAutorizadoError } from '../../errors/usuario/nao-autorizado.error.js';
import { UsuarioSessaoInvalidaError } from '../../errors/usuario/sessao-invalida.error.js';
import type { Observability } from '../../observability/observability.js';

export const AutorizarPermissaoUsuarioInputSchema = z.object({
  token: TokenSessaoSchema,
  permissao: PermissaoSchema,
});

export type AutorizarPermissaoUsuarioInput = z.infer<typeof AutorizarPermissaoUsuarioInputSchema>;

export interface AutorizarPermissaoUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly authService: AuthService;
  readonly observability: Observability;
}

/**
 * Verifica se o token de sessão é válido e se a conta tem a permissão pedida.
 *
 * Post-aperture-ibbet flow:
 *   1. `authService.validarSessao(token)` — collapses unknown / expired /
 *      revoked into a single `null` return (port contract). Expiry is now
 *      adapter-internal — the use-case no longer carries a clock dep.
 *   2. Load `Usuario` by `idUsuario` from the session — engine's auth
 *      principal is `Conta`, but auth identity is `Usuario`. Conta is
 *      derived via `Usuario.idConta` (1:1).
 *   3. Load `Conta` and run the pure `contaTemPermissao` predicate.
 *
 * Failure modes:
 *   - `null` session → `UsuarioSessaoInvalidaError('Token de sessao invalido')`
 *   - missing Usuario for the session's idUsuario → `UsuarioSessaoInvalidaError`
 *   - missing Conta for the Usuario → `UsuarioSessaoInvalidaError`
 *   - permission absent on Conta → `UsuarioNaoAutorizadoError`
 */
export async function autorizarPermissaoUsuario(
  deps: AutorizarPermissaoUsuarioDeps,
  input: AutorizarPermissaoUsuarioInput,
): Promise<void> {
  const { usuarioRepository, authService, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('autorizarPermissaoUsuario', async (span) => {
    try {
      const parsed = AutorizarPermissaoUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioSessaoInvalidaError(message);
      }

      const { token, permissao } = parsed.data;

      const sessao = await authService.validarSessao(token);
      if (!sessao) {
        throw new UsuarioSessaoInvalidaError('Token de sessao invalido');
      }

      const usuario = await usuarioRepository.findUsuarioById(sessao.idUsuario);
      if (!usuario) {
        throw new UsuarioSessaoInvalidaError('Usuario nao encontrado para a sessao');
      }

      const conta = await usuarioRepository.findContaById(usuario.idConta);
      if (!conta) {
        throw new UsuarioSessaoInvalidaError('Conta nao encontrada para a sessao');
      }

      if (!contaTemPermissao(conta, permissao)) {
        throw new UsuarioNaoAutorizadoError(permissao);
      }

      logger.info('usuario.permissao.autorizada', {
        idConta: conta.id,
        permissao,
      });

      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
