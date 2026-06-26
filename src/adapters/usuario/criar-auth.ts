import { randomUUID } from 'node:crypto';
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

  /**
   * OPTIONAL social-login providers (aperture-8655f). Engine ships the
   * helper; consumers inject deployment-specific OAuth credentials read
   * from env. When omitted/undefined, NO social provider is registered and
   * BetterAuth runs email+password only — the server still boots cleanly in
   * environments without OAuth credentials (the eunenem-server gates this on
   * GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET both being present).
   *
   * Shape mirrors BetterAuth's `socialProviders` option; the OAuth callback
   * lands at the standard `<baseURL>/api/auth/callback/<provider>` path
   * (already mounted via `auth.handler` at `/api/auth/*`).
   */
  readonly socialProviders?: BetterAuthOptions['socialProviders'];

  /**
   * Default platform id injected into adapter-created users (e.g. OAuth signup)
   * that don't carry one (aperture-dm7s3). The Google profile has NO
   * idPlataforma and the `users.id_plataforma` column is notNull, so without
   * this a brand-new Google signup fails at user-create. Email+password signup
   * sets idPlataforma explicitly via raw Kysely (criarConta) and bypasses
   * BetterAuth's create path entirely, so it never relies on this. Consumers
   * enabling OAuth signup MUST provide it — eunenem-server passes
   * ID_PLATAFORMA_EUNENEM (it is effectively single-tenant for OAuth signup).
   */
  readonly idPlataformaPadrao?: string;
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
 * **Email + password** always on (operator decision #5). Social providers
 * are OPTIONAL (aperture-8655f) — registered only when the consumer injects
 * `config.socialProviders`; absent → email+password-only. NO plugins
 * (admin/magicLink/twoFactor/etc all skipped). Add them in later beads if the
 * operator opts in.
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
  // Captured as a const so the narrowing (string when set) holds inside the
  // databaseHooks closure below (aperture-dm7s3).
  const idPlataformaPadrao = config.idPlataformaPadrao;

  const options = {
    database: {
      db: kysely,
      type: 'postgres' as const,
      // aperture-bq2c9: in better-auth@1.6.12 `casing` only affects TABLE names —
      // it is NOT applied to COLUMN names by the kysely adapter (verified in
      // @better-auth/core get-tables.mjs + @better-auth/kysely-adapter: columns
      // resolve via per-field `fieldName` only, no casing transform). Table names
      // are already pinned explicitly via each model's `modelName` below, so this
      // is belt-and-suspenders. COLUMN snake_casing is done by the explicit
      // `fields` maps on every model below — do NOT delete them trusting this.
      casing: 'snake' as const,
    },
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: [...config.trustedOrigins],
    advanced: {
      useSecureCookies,
      // aperture-6wo1f — adapter-created users (OAuth signup) MUST get a
      // UUID id. The domain `usuarios.id` column is Postgres `uuid` (migration
      // 008) and `IdUsuarioSchema` is `z.uuid()`, while the documented
      // invariant (migration 009 header) is `users.id == usuarios.id`. The
      // email+password path supplies its own UUID via raw Kysely in
      // `criarConta` (bypassing this generator), but BetterAuth's NATIVE
      // create path (OAuth) would otherwise mint its default non-UUID base62
      // id — which can NEVER be inserted into the uuid-typed `usuarios.id`
      // during the `me`-resolver self-heal. A custom `() => randomUUID()` is
      // used rather than `generateId: 'uuid'` because the kysely-adapter's
      // built-in 'uuid' mode relies on a DB-side `gen_random_uuid()` DEFAULT
      // (our columns have none → it inserts NULL and the create fails). This
      // generator runs ONLY on adapter-driven creates (OAuth) — email+password
      // never reaches it.
      database: {
        generateId: () => randomUUID(),
      },
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
      // aperture-bq2c9: snake_case column mapping (migration 009). token/id match.
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    user: {
      modelName: 'users',
      // aperture-bq2c9: snake_case column mapping (migration 009). name/email/
      // image/id match. emailVerified/createdAt/updatedAt need explicit mapping.
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      additionalFields: {
        idPlataforma: {
          type: 'string',
          // aperture-dm7s3: required:false — BetterAuth validates required
          // additionalFields at INPUT time, BEFORE the user.create.before hook
          // runs. With required:true + input:false the OAuth create fails with
          // "idPlataforma is required" (input can't supply it, and the Google
          // profile has none). required:false lets input validation pass; the
          // create.before hook then injects the server constant, and the DB
          // notNull (migration 009) is the backstop guaranteeing it's set.
          required: false,
          // aperture-9tca0: input:false — idPlataforma must NEVER be settable via
          // a BetterAuth HTTP route. The engine writes it via raw Kysely in
          // criarConta (tRPC saga); it is never user-supplied input. With input:true
          // it was writable through POST /api/auth/update-user → cross-tenant
          // escalation (any authed user could move tenants). input:false blocks the
          // HTTP-input path while programmatic writes (saga/hooks) still work.
          input: false,
          // aperture-bq2c9: column is id_plataforma (migration 009). Latent until
          // now — the adapter would have emitted 'idPlataforma' on OAuth signup.
          fieldName: 'id_plataforma',
        },
      },
    },
    account: {
      modelName: 'accounts',
      // aperture-bq2c9: map every multi-word BetterAuth `account` field to its
      // snake_case column (migration 009). Without this the adapter emits
      // camelCase (accounts.accountId) → Postgres 42703 → 500 on the whole OAuth
      // flow. The OAuth path is the FIRST consumer of the adapter (email+password
      // bypasses it via raw Kysely), which is why this was latent until #284.
      fields: {
        userId: 'user_id',
        providerId: 'provider_id',
        accountId: 'account_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        // password, scope, id are single-word → column name already matches.
      },
      // aperture-w2bty (Cipher security gate). OAuth sign-in must NEVER implicitly
      // merge into an existing local account (account-takeover / pre-hijack class).
      // disableImplicitLinking makes that explicit + independent of email_verified.
      accountLinking: { trustedProviders: [], disableImplicitLinking: true },
      // FORWARD-FRICTION: do NOT flip disableImplicitLinking off without (a) a real
      // email-verification flow AND (b) Cipher re-review — the takeover gate lives here.
    },
    verification: {
      modelName: 'verifications',
      // aperture-bq2c9: snake_case column mapping (migration 009). identifier/
      // value/id match. expiresAt is written on EVERY OAuth state round-trip
      // (createVerificationValue) — the first 500 the broken adapter produced.
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    rateLimit: {
      storage: 'database',
      modelName: 'rate_limit',
      // aperture-bq2c9: rate-limit storage goes through the adapter too. key/count
      // match; lastRequest → last_request (migration 009). BetterAuth's HTTP
      // handler rate-limits the OAuth routes, so this path activates with #284.
      fields: {
        lastRequest: 'last_request',
      },
    },
    // aperture-8655f — social providers are CONDITIONAL: only spread in when
    // the consumer injected them (both OAuth env vars present on its side).
    // Absent → key is omitted entirely → email+password-only, boots cleanly.
    ...(config.socialProviders ? { socialProviders: config.socialProviders } : {}),
    // aperture-dm7s3 — inject the default platform id on adapter-driven user
    // creation (OAuth signup) when the row carries none. The Google profile has
    // no idPlataforma + users.id_plataforma is notNull, so without this a
    // brand-new Google signup fails at user-create. Email+password (raw Kysely
    // criarConta) bypasses BetterAuth's create path, so it never hits this hook.
    // Only registered when the consumer injects idPlataformaPadrao.
    ...(idPlataformaPadrao
      ? {
          databaseHooks: {
            user: {
              create: {
                // SERVER-SOURCED ONLY (aperture-dm7s3 + Cipher tenancy gate):
                // the platform id is ALWAYS the injected server constant and is
                // NEVER read from anything in the request (OAuth state/header/
                // body / the incoming `user` object). Reading a user-influenceable
                // source would re-open the exact cross-tenant vector that 9tca0's
                // idPlataforma input:false just closed — via the signup path
                // instead of update-user. So we OVERRIDE unconditionally; the
                // value can only ever be `idPlataformaPadrao` (a server constant).
                before: async (user: Record<string, unknown>) => {
                  return { data: { ...user, idPlataforma: idPlataformaPadrao } };
                },
              },
            },
          },
        }
      : {}),
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

/** The fully-constructed Auth instance returned by `criarAuth`. */
export type Auth = ReturnType<typeof criarAuth>;
