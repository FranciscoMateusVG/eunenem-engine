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
  /**
   * Optional already-hashed client IP for forensic correlation
   * (aperture-3pqt7). Forwarded as-is to `AuthService.iniciarSessao` so
   * BetterAuth-side persistence writes it to `sessions.ip_address`.
   * Hashing happens at the HTTP boundary (eunenem-server tRPC layer via
   * `hashClientPII`) — this use-case treats the value as opaque. Tests
   * and internal flows without IP context pass `undefined`.
   */
  ipHashed: z.string().min(1).max(128).optional(),
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
 * Token generation, session storage, TTL, AND the (idPlataforma, email)
 * lookup all live inside the `AuthService` adapter (aperture-ibbet) —
 * this use-case is a thin coordinator that:
 *   1. Validates input.
 *   2. Delegates credential check + session issuance to the AuthService.
 *      AuthService performs its own (idPlataforma, email) lookup +
 *      scrypt verifyPassword internally, so on bad credentials it
 *      throws an ambiguous error in CONSTANT time regardless of
 *      whether the email exists.
 *   3. ON SUCCESS, fetches the domain Usuario via `findUsuarioById`
 *      (`sessao.idUsuario` is the auth principal; we resolve the
 *      matching domain Usuario to derive `idConta` for the result).
 *
 * **Timing-attack resistance (aperture-swmpm).** Previously this code
 * pre-checked `findUsuarioByEmail` and threw on null BEFORE calling
 * `iniciarSessao`. The error MESSAGE matched the AuthService bad-credential
 * throw, but the TIMING did not — an unknown-email attempt skipped the
 * ~50–200 ms scrypt verifyPassword inside iniciarSessao, producing a
 * measurable delta an attacker could use to enumerate registered emails
 * by stopwatch (Cipher's H4 finding from the aperture-ebspa security
 * review, 2026-05-30). The new shape routes BOTH paths (unknown-email
 * AND wrong-password-for-known-email) through the same scrypt code path
 * inside AuthService → timing is indistinguishable.
 *
 * Returns an ambiguous `UsuarioInputInvalidoError` on either missing
 * user or wrong password — the `AuthService` itself enforces this.
 *
 * **Defensive `findUsuarioById` failure path.** After `iniciarSessao`
 * succeeds we look up the domain Usuario by id. If it returns
 * `undefined` — which would indicate a data-model inconsistency, NOT a
 * credential failure — we throw a generic Error so the drift surfaces
 * loudly in logs rather than masking as the ambiguous bad-credentials
 * error. This path should be unreachable in healthy systems: every auth
 * Usuario row is created via the saga that also writes the domain
 * Usuario, with compensation on partial failure.
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

      const { idPlataforma, email, senhaSimulada, ipHashed } = parsed.data;

      span.setAttribute('usuario.plataforma.id', idPlataforma);
      span.setAttribute('usuario.email.length', email.length);

      // Delegate credential check + session issuance FIRST. AuthService
      // performs its own (idPlataforma, email) lookup + scrypt
      // verifyPassword internally — both unknown-email and wrong-password
      // paths exit through the same constant-time error throw. NEVER add
      // a pre-check here that lets one path skip the scrypt verify
      // (regression would re-introduce the H4 user-enumeration oracle).
      // Spread the optional ipHashed conditionally — tsconfig has
      // `exactOptionalPropertyTypes: true` so passing `undefined`
      // explicitly is a type error. Omit the key when not present.
      const sessao = await authService.iniciarSessao({
        idPlataforma,
        email,
        senha: senhaSimulada,
        ...(ipHashed ? { ipHashed } : {}),
      });

      // Resolve domain Usuario by id (auth principal → domain principal).
      // Should be unreachable in a healthy system; see header docstring.
      const usuario = await usuarioRepository.findUsuarioById(sessao.idUsuario);
      if (!usuario) {
        logger.info('usuario.sessao.dominio_inconsistente', {
          idUsuario: sessao.idUsuario,
          idPlataforma,
        });
        throw new Error(
          `Sessao criada para idUsuario "${sessao.idUsuario}" mas Usuario de dominio nao encontrado (inconsistencia auth+dominio).`,
        );
      }

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
