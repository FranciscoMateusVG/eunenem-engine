import type { BetterAuthOptions, User } from 'better-auth';
import { betterAuth } from 'better-auth';
import type { Database } from '../database.js';

/**
 * Config shape accepted by `criarAuth` (aperture-g7f68).
 *
 * Engine ships the helper + adapter; consumers (eunenem-server in
 * aperture-ht7sq, others later) inject deployment-specific values.
 * Email transport stays at the consumer boundary so the engine has zero
 * SMTP/SES coupling.
 */
export interface CriarAuthConfig {
  /** BetterAuth signing secret (≥32 chars). Read from env on the consumer side. */
  readonly secret: string;

  /** Public base URL (e.g. `https://eunenem.programaincluir.org`). */
  readonly baseURL: string;

  /**
   * Origins explicitly allowed for cookie-bearing requests (T6 from
   * monorepo-incluir recon §4 — NO wildcard, list every origin).
   * Engine appends `baseURL` automatically; this list is additive.
   */
  readonly trustedOrigins: readonly string[];

  /**
   * Callback BetterAuth invokes when issuing a password-reset link. The
   * consumer wires SMTP / SES / etc. Engine never touches transports.
   */
  readonly sendResetPassword: (input: { user: User; url: string; token: string }) => Promise<void>;

  /**
   * HTTPS-only cookies. Defaults to `process.env.NODE_ENV === 'production'`
   * per T8 from recon §4 — flip explicitly in tests if you need to override.
   */
  readonly useSecureCookies?: boolean;
}

/**
 * Build a BetterAuth instance wired into the engine's existing Kysely
 * pool (aperture-g7f68 — Pattern A from recon aperture-q2i8l §5).
 *
 * **Pool sharing**: passes the engine's Kysely instance directly via
 * `database: { db, type: 'postgres', casing: 'snake' }`. Better than
 * monorepo-incluir's raw-pg.Pool pattern (recon anti-trap §8 #2 —
 * maintainer-recommended, one Kysely, one pool, one migration runner).
 *
 * **Email + password ONLY** (operator decision #5). NO socialProviders,
 * NO plugins (admin/magicLink/twoFactor/etc all skipped). Add them in
 * later beads if the operator opts in.
 *
 * **Rate-limit storage = database** (operator decision #4). The
 * `rate_limit` table from migration 009 backs it. Survives multi-instance
 * deploys; in-memory would reset on every container restart and would
 * not share state across replicas.
 *
 * **Session posture** (T2 — explicit in config, with reasoning):
 *   - expiresIn 7 days  — week-long browser sessions, typical for
 *     dashboard apps
 *   - updateAge 1 day   — refresh server-side every ~24h of activity
 *   - freshAge 1 day    — operations like password change require a
 *     session  ≤24h old
 *
 * **snake_case** via `database.casing: 'snake'` — matches the column
 * names in migration 009 (BetterAuth's defaults would otherwise write
 * camelCase column names like `emailVerified`).
 *
 * **Composite uniqueness** preserved via additionalFields: BetterAuth's
 * `users` table carries `idPlataforma` (required) so the migration's
 * `users_plataforma_email_uniq` constraint enforces tenancy at the auth
 * layer too. The eunenem-server (child 4) must include `idPlataforma`
 * in the signUp payload — anti-trap §8 #8 multi-tenant auth.
 */
export function criarAuth(kysely: Database, config: CriarAuthConfig) {
  const useSecureCookies = config.useSecureCookies ?? process.env.NODE_ENV === 'production';

  const options = {
    database: {
      db: kysely,
      type: 'postgres' as const,
      casing: 'snake' as const,
    },
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [...config.trustedOrigins],
    advanced: {
      useSecureCookies,
    },
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url, token }) => {
        await config.sendResetPassword({ user, url, token });
      },
    },
    session: {
      modelName: 'sessions',
      expiresIn: 60 * 60 * 24 * 7, // 7 days, in seconds
      updateAge: 60 * 60 * 24, // 1 day, in seconds
      freshAge: 60 * 60 * 24, // 1 day, in seconds
    },
    user: {
      modelName: 'users',
      additionalFields: {
        idPlataforma: {
          type: 'string',
          required: true,
          input: true,
        },
      },
    },
    account: {
      modelName: 'accounts',
    },
    verification: {
      modelName: 'verifications',
    },
    rateLimit: {
      storage: 'database',
      modelName: 'rate_limit',
    },
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

/** The fully-constructed Auth instance returned by `criarAuth`. */
export type Auth = ReturnType<typeof criarAuth>;
