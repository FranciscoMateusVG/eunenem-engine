import { randomBytes } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { EmailUsuario } from '../../domain/usuario/value-objects/email-usuario.js';
import type { IdPlataformaReferencia, IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { NomeExibicaoUsuario } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import {
  type TokenSessao,
  TokenSessaoSchema,
} from '../../domain/usuario/value-objects/token-sessao.js';
import { UsuarioEmailJaExisteError } from '../../errors/usuario/email-ja-existe.error.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { AuthService } from './auth-service.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'usuario_auth',
} as const;

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1h

interface ContaAuth {
  readonly idUsuario: IdUsuario;
  readonly idPlataforma: IdPlataformaReferencia;
  readonly email: EmailUsuario;
  readonly nome: NomeExibicaoUsuario;
  senha: string; // mutable — alterarSenha overwrites
}

interface SessaoMemoria {
  readonly idUsuario: IdUsuario;
  readonly expiraEm: Date;
}

function emailKey(idPlataforma: IdPlataformaReferencia, email: EmailUsuario): string {
  return `${idPlataforma}::${email}`;
}

function defaultTokenGenerator(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * In-memory `AuthService` adapter (aperture-ibbet).
 *
 * Replaces the pre-refactor SenhaSimulada + TokenSessao adapter pair. The
 * "simulated auth" lives ENTIRELY inside this adapter going forward — the
 * domain layer (Usuario aggregate, use-cases) is auth-implementation-agnostic.
 *
 * **Storage model**:
 *   - `accountsByKey`: composite (idPlataforma, email) → ContaAuth (the
 *     auth principal). Mirrors BetterAuth's user table but scoped per
 *     plataforma to preserve composite uniqueness.
 *   - `accountsByIdUsuario`: idUsuario → composite key, so `alterarSenha`
 *     and `removerConta` can find rows by id without an O(n) scan.
 *   - `sessionsByToken`: TokenSessao → {idUsuario, expiraEm}. Sessions
 *     reference idUsuario (not idConta — engine's auth principal is
 *     Conta but auth identity is Usuario, see recon §8 #4).
 *
 * **Construction options**: clock + sessionTtlMs + tokenGenerator are
 * injectable. Tests use the fixed `clock` from the suite to assert exact
 * `expiraEm`; the BetterAuth-future adapter will carry these via the
 * BetterAuth instance config instead.
 *
 * **Test seam**: `seedSession(...)` is NOT on the port — it's exposed on
 * the concrete class so tests that need a specific token / expired session /
 * orphan idUsuario can stage exact state without going through
 * `iniciarSessao` (which always uses the current clock + ttl).
 */
export class AuthServiceMemoria implements AuthService {
  private readonly accountsByKey = new Map<string, ContaAuth>();
  private readonly accountsByIdUsuario = new Map<IdUsuario, string>();
  private readonly sessionsByToken = new Map<TokenSessao, SessaoMemoria>();

  private readonly clock: () => Date;
  private readonly sessionTtlMs: number;
  private readonly tokenGenerator: () => string;

  constructor(
    opts: {
      readonly clock?: () => Date;
      readonly sessionTtlMs?: number;
      readonly tokenGenerator?: () => string;
    } = {},
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.tokenGenerator = opts.tokenGenerator ?? defaultTokenGenerator;
  }

  async criarConta(input: {
    readonly idUsuario: IdUsuario;
    readonly idPlataforma: IdPlataformaReferencia;
    readonly email: EmailUsuario;
    readonly senha: string;
    readonly nome: NomeExibicaoUsuario;
  }): Promise<{ readonly idUsuario: IdUsuario }> {
    return tracer.startActiveSpan('auth.memoria.criarConta', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const key = emailKey(input.idPlataforma, input.email);
        if (this.accountsByKey.has(key)) {
          throw new UsuarioEmailJaExisteError(input.email);
        }
        if (this.accountsByIdUsuario.has(input.idUsuario)) {
          throw new UsuarioInputInvalidoError(
            `idUsuario ${input.idUsuario} ja existe no AuthService`,
          );
        }

        const conta: ContaAuth = {
          idUsuario: input.idUsuario,
          idPlataforma: input.idPlataforma,
          email: input.email,
          nome: input.nome,
          senha: input.senha,
        };
        this.accountsByKey.set(key, conta);
        this.accountsByIdUsuario.set(input.idUsuario, key);

        span.setStatus({ code: SpanStatusCode.OK });
        return { idUsuario: input.idUsuario };
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async iniciarSessao(input: {
    readonly idPlataforma: IdPlataformaReferencia;
    readonly email: EmailUsuario;
    readonly senha: string;
    /** Ignored by the memory adapter (no sessions table). aperture-3pqt7. */
    readonly ipHashed?: string;
  }): Promise<{
    readonly idUsuario: IdUsuario;
    readonly token: TokenSessao;
    readonly expiraEm: Date;
  }> {
    return tracer.startActiveSpan('auth.memoria.iniciarSessao', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const key = emailKey(input.idPlataforma, input.email);
        const conta = this.accountsByKey.get(key);
        if (!conta || conta.senha !== input.senha) {
          // Deliberately ambiguous error — do not leak "user exists, wrong
          // password" vs "no such user" to the caller.
          throw new UsuarioInputInvalidoError('Email ou senha invalidos');
        }

        const now = this.clock();
        const token = TokenSessaoSchema.parse(this.tokenGenerator());
        const expiraEm = new Date(now.getTime() + this.sessionTtlMs);
        this.sessionsByToken.set(token, { idUsuario: conta.idUsuario, expiraEm });

        span.setStatus({ code: SpanStatusCode.OK });
        return { idUsuario: conta.idUsuario, token, expiraEm };
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async validarSessao(
    token: TokenSessao,
  ): Promise<{ readonly idUsuario: IdUsuario; readonly expiraEm: Date } | null> {
    return tracer.startActiveSpan('auth.memoria.validarSessao', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const sessao = this.sessionsByToken.get(token);
        if (!sessao) {
          span.setStatus({ code: SpanStatusCode.OK });
          return null;
        }
        if (this.clock().getTime() >= sessao.expiraEm.getTime()) {
          // Auto-revoke expired sessions — keep the map clean. Same
          // observable behavior as the old SessaoUsuarioRepository + the
          // `sessaoExpirada` predicate: expired ⇒ invalid.
          this.sessionsByToken.delete(token);
          span.setStatus({ code: SpanStatusCode.OK });
          return null;
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return { idUsuario: sessao.idUsuario, expiraEm: sessao.expiraEm };
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async revogarSessao(token: TokenSessao): Promise<void> {
    return tracer.startActiveSpan('auth.memoria.revogarSessao', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        this.sessionsByToken.delete(token);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async alterarSenha(input: {
    readonly idUsuario: IdUsuario;
    readonly novaSenha: string;
  }): Promise<void> {
    return tracer.startActiveSpan('auth.memoria.alterarSenha', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const key = this.accountsByIdUsuario.get(input.idUsuario);
        const conta = key ? this.accountsByKey.get(key) : undefined;
        if (!conta) {
          throw new UsuarioInputInvalidoError(
            `idUsuario ${input.idUsuario} nao encontrado no AuthService`,
          );
        }
        conta.senha = input.novaSenha;
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async removerConta(idUsuario: IdUsuario): Promise<void> {
    return tracer.startActiveSpan('auth.memoria.removerConta', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        const key = this.accountsByIdUsuario.get(idUsuario);
        if (key) {
          this.accountsByKey.delete(key);
          this.accountsByIdUsuario.delete(idUsuario);
        }
        // Tear down all sessions for this user.
        for (const [token, sessao] of this.sessionsByToken.entries()) {
          if (sessao.idUsuario === idUsuario) {
            this.sessionsByToken.delete(token);
          }
        }
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * **Test-only.** Seed a session directly into the map. Not part of the
   * `AuthService` port — exposed on the concrete class so tests can stage
   * an exact session shape (expired, orphan idUsuario, specific token)
   * that the normal `iniciarSessao` flow would not produce.
   */
  seedSession(input: {
    readonly token: TokenSessao;
    readonly idUsuario: IdUsuario;
    readonly expiraEm: Date;
  }): void {
    this.sessionsByToken.set(input.token, {
      idUsuario: input.idUsuario,
      expiraEm: input.expiraEm,
    });
  }
}
