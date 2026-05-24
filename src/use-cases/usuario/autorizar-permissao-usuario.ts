import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { SessaoUsuarioRepository } from '../../adapters/usuario/sessao-repository.js';
import { sessaoExpirada } from '../../domain/usuario/entities/sessao.js';
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
  readonly sessaoRepository: SessaoUsuarioRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Verifica se o token de sessão é válido e se a conta tem a permissão pedida.
 */
export async function autorizarPermissaoUsuario(
  deps: AutorizarPermissaoUsuarioDeps,
  input: AutorizarPermissaoUsuarioInput,
): Promise<void> {
  const { usuarioRepository, sessaoRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('autorizarPermissaoUsuario', async (span) => {
    try {
      const parsed = AutorizarPermissaoUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioSessaoInvalidaError(message);
      }

      const { token, permissao } = parsed.data;

      const sessao = await sessaoRepository.findByToken(token);
      if (!sessao) {
        throw new UsuarioSessaoInvalidaError('Token de sessao desconhecido');
      }

      if (sessaoExpirada(sessao, clock())) {
        throw new UsuarioSessaoInvalidaError('Sessao expirada');
      }

      const conta = await usuarioRepository.findContaById(sessao.idConta);
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
