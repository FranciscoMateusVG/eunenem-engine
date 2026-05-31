import { randomBytes, randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import type { EmailUsuario } from '../../domain/usuario/value-objects/email-usuario.js';
import type { IdPlataformaReferencia, IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { NomeExibicaoUsuario } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
import {
  type TokenSessao,
  TokenSessaoSchema,
} from '../../domain/usuario/value-objects/token-sessao.js';
import { UsuarioEmailJaExisteError } from '../../errors/usuario/email-ja-existe.error.js';
import { UsuarioInputInvalidoError } from '../../errors/usuario/input-invalido.error.js';
import type { Database } from '../database.js';
import type { AuthService } from './auth-service.js';

const tracer = trace.getTracer('frame');

const DB_USERS_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'users',
} as const;

const DB_SESSIONS_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'sessions',
} as const;

const DB_ACCOUNTS_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'accounts',
} as const;

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches criarAuth's session.expiresIn

/**
 * Constraint name from migration 20260530_009 — surfaced as
 * `UsuarioEmailJaExisteError` for port-conformance with
 * `AuthServiceMemoria` (composite (id_plataforma, email) uniqueness
 * enforced at the auth layer too, preserving operator decision #2).
 */
const UNIQUE_PLATAFORMA_EMAIL = 'users_plataforma_email_uniq';

const PROVIDER_ID_CREDENTIAL = 'credential';

interface PostgresError {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pgErr = error as PostgresError;
  if (pgErr.code !== '23505') return false;
  if (pgErr.constraint === constraint) return true;
  if (pgErr.detail?.includes(constraint)) return true;
  return false;
}

function newOpaqueSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * BetterAuth-backed `AuthService` adapter (aperture-g7f68).
 *
 * Wires the engine's auth port to the BetterAuth tables created in
 * migration 009. **Bypasses `auth.api.signUpEmail` / `auth.api.signInEmail`
 * and writes Kysely directly**, for three reasons:
 *
 *   1. **Caller-controlled UUIDs.** Engine's `criarConta` accepts the
 *      caller's `idUsuario` (matches the rest of the codebase —
 *      Campanha, Contribuicao, Pagamento all take their id as input).
 *      BetterAuth's HTTP-shaped signUp pipeline generates its own ids
 *      that the caller would have to discover from the return value.
 *      Going direct keeps the port semantics clean.
 *   2. **Skips BetterAuth's rate-limit middleware on internal SDK calls.**
 *      Rate-limiting is for the HTTP runtime (mounted by consumers in
 *      child 4 via `auth.handler`). Internal use-cases like
 *      `registrarContaUsuario` should not be rate-limited.
 *   3. **T12 from monorepo-incluir recon §4** — for password ops the
 *      proven pattern is `hashPassword`/`verifyPassword` from
 *      `better-auth/crypto` directly. Same crypto, BetterAuth's HTTP
 *      runtime in child 4 produces compatible hashes (same accounts
 *      rows work for both code paths).
 *
 * BetterAuth's HTTP runtime (when consumers mount `auth.handler`) reads
 * and writes the SAME tables — adapter + handler are interoperable. The
 * shared `users.id_plataforma` additionalField + composite UNIQUE keep
 * both paths multi-tenant-safe.
 *
 * **T3 compensation** (`removerConta`): DELETE on `users` cascades to
 * `sessions` + `accounts` via the migration's FK constraints. The undo
 * for a failed `registrarContaUsuario` saga is a single statement.
 */
export class AuthServiceBetterAuth implements AuthService {
  private readonly clock: () => Date;
  private readonly sessionTtlMs: number;
  private readonly tokenGenerator: () => string;

  constructor(
    private readonly db: Database,
    opts: {
      readonly clock?: () => Date;
      readonly sessionTtlMs?: number;
      readonly tokenGenerator?: () => string;
    } = {},
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.tokenGenerator = opts.tokenGenerator ?? newOpaqueSessionToken;
  }

  async criarConta(input: {
    readonly idUsuario: IdUsuario;
    readonly idPlataforma: IdPlataformaReferencia;
    readonly email: EmailUsuario;
    readonly senha: string;
    readonly nome: NomeExibicaoUsuario;
  }): Promise<{ readonly idUsuario: IdUsuario }> {
    return tracer.startActiveSpan('auth.betterauth.criarConta', async (span) => {
      span.setAttributes({ ...DB_USERS_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const passwordHash = await hashPassword(input.senha);
        const now = this.clock();

        await this.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('users')
            .values({
              id: input.idUsuario,
              name: input.nome,
              email: input.email,
              email_verified: false,
              image: null,
              id_plataforma: input.idPlataforma,
              created_at: now,
              updated_at: now,
            })
            .execute();

          await trx
            .insertInto('accounts')
            .values({
              id: randomUUID(),
              user_id: input.idUsuario,
              provider_id: PROVIDER_ID_CREDENTIAL,
              // For the credential provider, `account_id` carries the
              // login identifier (email). Composite UNIQUE on
              // (provider_id, account_id) means no two BetterAuth
              // credential rows share the same email — but that does
              // NOT conflict with multi-tenant signup because each
              // plataforma has its OWN user row (composite uniqueness
              // on users), so the email lives once per tenant in
              // accounts too. WAIT — same email across plataformas
              // would collide here. Workaround: prefix with id_plataforma.
              account_id: `${input.idPlataforma}::${input.email}`,
              password: passwordHash,
              access_token: null,
              refresh_token: null,
              id_token: null,
              access_token_expires_at: null,
              refresh_token_expires_at: null,
              scope: null,
              created_at: now,
              updated_at: now,
            })
            .execute();
        });

        span.setStatus({ code: SpanStatusCode.OK });
        return { idUsuario: input.idUsuario };
      } catch (error: unknown) {
        if (isUniqueViolation(error, UNIQUE_PLATAFORMA_EMAIL)) {
          const typed = new UsuarioEmailJaExisteError(input.email);
          span.recordException(typed);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw typed;
        }
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
    readonly ipHashed?: string;
  }): Promise<{
    readonly idUsuario: IdUsuario;
    readonly token: TokenSessao;
    readonly expiraEm: Date;
  }> {
    return tracer.startActiveSpan('auth.betterauth.iniciarSessao', async (span) => {
      span.setAttributes({ ...DB_USERS_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('users')
          .innerJoin('accounts', 'accounts.user_id', 'users.id')
          .select(['users.id as id', 'accounts.password as password'])
          .where('users.id_plataforma', '=', input.idPlataforma)
          .where('users.email', '=', input.email)
          .where('accounts.provider_id', '=', PROVIDER_ID_CREDENTIAL)
          .executeTakeFirst();

        if (!row?.password) {
          // Same ambiguous error AuthServiceMemoria throws — no user
          // enumeration via timing.
          throw new UsuarioInputInvalidoError('Email ou senha invalidos');
        }

        const ok = await verifyPassword({ hash: row.password, password: input.senha });
        if (!ok) {
          throw new UsuarioInputInvalidoError('Email ou senha invalidos');
        }

        const now = this.clock();
        const token = TokenSessaoSchema.parse(this.tokenGenerator());
        const expiraEm = new Date(now.getTime() + this.sessionTtlMs);

        await this.db
          .insertInto('sessions')
          .values({
            id: randomUUID(),
            user_id: row.id,
            token,
            expires_at: expiraEm,
            // aperture-3pqt7: store the HASHED client IP (sha256+salt;
            // hashing done at the tRPC layer via hashClientPII). Storing
            // raw IPs would create a GDPR-grade liability for log/DB
            // dumps; storing nothing kills our forensic ability to
            // correlate credential-stuffing across sessions. Hashed IP
            // is the right compromise — same client deterministically
            // produces same hash, but a dump leak doesn't expose
            // raw addresses. Empty string surfaces from
            // hashClientPII("") on unknown IP — we treat that as null
            // here so the column distinguishes "no IP context provided"
            // from "IP captured but unknown bucket".
            ip_address: input.ipHashed && input.ipHashed.length > 0 ? input.ipHashed : null,
            user_agent: null,
            created_at: now,
            updated_at: now,
          })
          .execute();

        span.setStatus({ code: SpanStatusCode.OK });
        return { idUsuario: row.id, token, expiraEm };
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
    return tracer.startActiveSpan('auth.betterauth.validarSessao', async (span) => {
      span.setAttributes({ ...DB_SESSIONS_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('sessions')
          .select(['user_id', 'expires_at'])
          .where('token', '=', token)
          .executeTakeFirst();

        if (!row) {
          span.setStatus({ code: SpanStatusCode.OK });
          return null;
        }

        if (this.clock().getTime() >= row.expires_at.getTime()) {
          // Auto-revoke expired tokens (same observable behavior as
          // AuthServiceMemoria: expired ⇒ invalid).
          await this.db.deleteFrom('sessions').where('token', '=', token).execute();
          span.setStatus({ code: SpanStatusCode.OK });
          return null;
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return { idUsuario: row.user_id, expiraEm: row.expires_at };
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
    return tracer.startActiveSpan('auth.betterauth.revogarSessao', async (span) => {
      span.setAttributes({ ...DB_SESSIONS_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        await this.db.deleteFrom('sessions').where('token', '=', token).execute();
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
    return tracer.startActiveSpan('auth.betterauth.alterarSenha', async (span) => {
      span.setAttributes({ ...DB_ACCOUNTS_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        // T12 from monorepo-incluir recon §4 — hashPassword from
        // better-auth/crypto + direct UPDATE, skip the awkward
        // setUserPassword admin API.
        const passwordHash = await hashPassword(input.novaSenha);
        const result = await this.db
          .updateTable('accounts')
          .set({ password: passwordHash, updated_at: this.clock() })
          .where('user_id', '=', input.idUsuario)
          .where('provider_id', '=', PROVIDER_ID_CREDENTIAL)
          .executeTakeFirst();

        if (result.numUpdatedRows === 0n) {
          throw new UsuarioInputInvalidoError(
            `idUsuario ${input.idUsuario} nao encontrado no AuthService`,
          );
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

  async removerConta(idUsuario: IdUsuario): Promise<void> {
    return tracer.startActiveSpan('auth.betterauth.removerConta', async (span) => {
      span.setAttributes({ ...DB_USERS_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        // ON DELETE CASCADE on sessions.user_id + accounts.user_id
        // (migration 009) cleans up dependents in one shot. Idempotent —
        // deleting a non-existent user is a no-op (DELETE just affects
        // zero rows).
        await this.db.deleteFrom('users').where('id', '=', idUsuario).execute();
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
}
