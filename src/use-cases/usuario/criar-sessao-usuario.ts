import { randomBytes } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import type { SessaoUsuarioRepository } from '../../adapters/usuario/sessao-repository.js';
import type { CriarSessaoUsuarioInput, Sessao } from '../../domain/usuario/usuario.js';
import { CriarSessaoUsuarioInputSchema, TokenSessaoSchema } from '../../domain/usuario/usuario.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export interface CriarSessaoUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly sessaoRepository: SessaoUsuarioRepository;
  readonly clock: () => Date;
  /** Duração da sessão simulada (ms). */
  readonly sessionTtlMs: number;
  readonly observability: Observability;
}

function newOpaqueSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Cria uma sessão fake após validar email + palavra-passe simulada.
 */
export async function criarSessaoUsuario(
  deps: CriarSessaoUsuarioDeps,
  input: CriarSessaoUsuarioInput,
): Promise<Sessao> {
  const { usuarioRepository, sessaoRepository, clock, sessionTtlMs, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarSessaoUsuario', async (span) => {
    try {
      const parsed = CriarSessaoUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const { email, senhaSimulada } = parsed.data;

      span.setAttribute('usuario.email.length', email.length);

      const usuario = await usuarioRepository.findUsuarioByEmail(email);
      const credencial = usuario
        ? await usuarioRepository.findCredencialByIdUsuario(usuario.id)
        : undefined;

      if (!usuario || !credencial || credencial.senhaSimulada !== senhaSimulada) {
        throw new UsuarioInputInvalidoError('Email ou senha simulada invalidos');
      }

      const now = clock();
      const rawToken = newOpaqueSessionToken();
      const token = TokenSessaoSchema.parse(rawToken);

      const sessao: Sessao = {
        token,
        idConta: usuario.idConta,
        expiraEm: new Date(now.getTime() + sessionTtlMs),
      };

      await sessaoRepository.save(sessao);

      logger.info('usuario.sessao.criada', {
        idUsuario: usuario.id,
        idConta: usuario.idConta,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return sessao;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
