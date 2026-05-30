import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { AuthService } from '../../adapters/usuario/auth-service.js';
import type { UsuarioRepository } from '../../adapters/usuario/repository.js';
import { EmailUsuarioSchema } from '../../domain/usuario/value-objects/email-usuario.js';
import type {
  IdContaUsuario,
  IdPlataformaReferencia,
  IdUsuario,
} from '../../domain/usuario/value-objects/ids.js';
import { IdPlataformaReferenciaSchema } from '../../domain/usuario/value-objects/ids.js';
import type { TokenSessao } from '../../domain/usuario/value-objects/token-sessao.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Observability } from '../../observability/observability.js';

export const CriarSessaoUsuarioInputSchema = z.object({
  idPlataforma: IdPlataformaReferenciaSchema,
  email: EmailUsuarioSchema,
  /**
   * Plain-text password. Forwarded to `AuthService.iniciarSessao`.
   * Field name preserved for backward compatibility.
   */
  senhaSimulada: z.string().min(1, 'Senha nao pode ser vazia').max(200, 'Senha e longa demais'),
});

export type CriarSessaoUsuarioInput = z.infer<typeof CriarSessaoUsuarioInputSchema>;

export interface CriarSessaoUsuarioDeps {
  readonly usuarioRepository: UsuarioRepository;
  readonly authService: AuthService;
  readonly observability: Observability;
}

/**
 * Return shape (aperture-ibbet — replaces the deleted `Sessao` aggregate).
 * Carries `idPlataforma` + `idConta` for backward compatibility with
 * existing call sites that read those fields from the old `Sessao` type.
 */
export interface CriarSessaoUsuarioResult {
  readonly token: TokenSessao;
  readonly idUsuario: IdUsuario;
  readonly idPlataforma: IdPlataformaReferencia;
  readonly idConta: IdContaUsuario;
  readonly expiraEm: Date;
}

/**
 * Cria uma sessão após validar (idPlataforma, email) + palavra-passe.
 *
 * Token generation, session storage, and TTL all live inside the
 * `AuthService` adapter (aperture-ibbet) — this use-case is a thin
 * coordinator that:
 *   1. Validates input.
 *   2. Looks up the domain Usuario by (idPlataforma, email) so the
 *      result can carry `idConta` (which the auth layer does not know
 *      about — auth principal is Usuario, domain principal is Conta).
 *   3. Delegates credential check + session issuance to the AuthService.
 *   4. Combines the two into the public result shape.
 *
 * Returns an ambiguous `UsuarioInputInvalidoError` on either missing user
 * or wrong password — DO NOT leak which one failed (prevents user
 * enumeration). The AuthService itself enforces the same ambiguity.
 */
export async function criarSessaoUsuario(
  deps: CriarSessaoUsuarioDeps,
  input: CriarSessaoUsuarioInput,
): Promise<CriarSessaoUsuarioResult> {
  const { usuarioRepository, authService, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('criarSessaoUsuario', async (span) => {
    try {
      const parsed = CriarSessaoUsuarioInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new UsuarioInputInvalidoError(message);
      }

      const { idPlataforma, email, senhaSimulada } = parsed.data;

      span.setAttribute('usuario.plataforma.id', idPlataforma);
      span.setAttribute('usuario.email.length', email.length);

      // Look up the domain Usuario first so we can carry idConta in the
      // result. If missing, throw the same ambiguous error AuthService
      // would throw on a bad-credentials attempt — prevents user
      // enumeration via timing.
      const usuario = await usuarioRepository.findUsuarioByEmail(idPlataforma, email);
      if (!usuario) {
        throw new UsuarioInputInvalidoError('Email ou senha invalidos');
      }

      const sessao = await authService.iniciarSessao({
        idPlataforma,
        email,
        senha: senhaSimulada,
      });

      logger.info('usuario.sessao.criada', {
        idUsuario: usuario.id,
        idPlataforma: usuario.idPlataforma,
        idConta: usuario.idConta,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return {
        token: sessao.token,
        idUsuario: usuario.id,
        idPlataforma: usuario.idPlataforma,
        idConta: usuario.idConta,
        expiraEm: sessao.expiraEm,
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
