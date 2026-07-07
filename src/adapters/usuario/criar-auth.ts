import { randomUUID } from 'node:crypto';
import type { BetterAuthOptions, User } from 'better-auth';
import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { derivarNomeExibicaoFallback } from '../../domain/usuario/value-objects/nome-exibicao-usuario.js';
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
   * OPTIONAL magic-link sender (aperture-lwx2k / Camada C). When provided, the
   * BetterAuth `magicLink` plugin is enabled and this callback delivers the
   * link (the consumer wires the SMTP transport; the engine never touches
   * transports). When omitted/undefined the plugin is NOT registered and
   * BetterAuth runs without passwordless — the server still boots cleanly in
   * environments without SMTP creds (eunenem-server gates this on
   * SMTP_HOST/USER/PASS all being present, mirroring the google spread).
   *
   * ⚠️ SECURITY (Cipher keystone, aperture-79b31): enabling magic-link is an
   * email-ownership-proving sign-in. The `session.create.before` hook below
   * NULLs any local credential password on a verified-email session so a
   * pre-registered attacker's password cannot survive the victim's magic-link
   * login. Enabling this WITHOUT that hook re-opens an account-takeover.
   */
  readonly sendMagicLink?: (input: { email: string; url: string; token: string }) => Promise<void>;

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
/**
 * Two DISTINCT OAuth provider sets, with a one-way safety invariant between
 * them (aperture-qcrv4 + y5ual + etdx3 — Cipher security review).
 *
 * These are NOT the same list. Conflating them (y5ual's first cut) opened a
 * HIGH account-takeover (etdx3): putting a provider that does NOT verify email
 * ownership into the TRUSTED set lets an attacker spoof a victim's email and
 * implicit-link their identity into the victim's existing local account.
 *
 *   HOOK_COVERED — providers whose `account.create.before` create/link
 *     INVALIDATES the local credential password (the qcrv4 takeover defence).
 *     Safe to be broad: NULLing a password on link can only ever LOCK OUT, it
 *     never grants access.
 *
 *   TRUSTED — providers better-auth may IMPLICIT-LINK to an existing local
 *     account by email alone (accountLinking.trustedProviders). DANGEROUS to be
 *     broad: better-auth links trusted providers REGARDLESS of incoming
 *     emailVerified (callback.mjs:94). Only providers that cryptographically
 *     prove email ownership belong here. Google does (emailVerified=true,
 *     validated issuer). Microsoft multi-tenant `common` does NOT — a free
 *     Entra tenant can mint a token carrying any `email` with
 *     emailVerified=false (issuer validation is skipped for `common`), so
 *     trusting it = takeover. Microsoft is therefore HOOK_COVERED but NOT
 *     TRUSTED: an incoming Microsoft login won't auto-link into an existing
 *     account by email (better-auth returns account_not_linked); new Microsoft
 *     users still get fresh accounts.
 *
 * INVARIANT: TRUSTED ⊆ HOOK_COVERED. A trusted-but-not-hooked provider would
 * re-open the qcrv4 takeover; hooked-but-not-trusted is the safe asymmetry.
 * Asserted at module load below so the two lists can never silently drift.
 */
const HOOK_COVERED_OAUTH_PROVIDERS = ['google', 'microsoft'] as const;
const TRUSTED_OAUTH_PROVIDERS = ['google'] as const;
type HookCoveredOAuthProvider = (typeof HOOK_COVERED_OAUTH_PROVIDERS)[number];

// Enforce TRUSTED ⊆ HOOK_COVERED at module load — fail fast on a future edit
// that trusts a provider without hook coverage (the takeover direction).
for (const trusted of TRUSTED_OAUTH_PROVIDERS) {
  if (!(HOOK_COVERED_OAUTH_PROVIDERS as readonly string[]).includes(trusted)) {
    throw new Error(
      `OAuth config invariant violated: trusted provider "${trusted}" is not in HOOK_COVERED_OAUTH_PROVIDERS (TRUSTED must be a subset of HOOK_COVERED)`,
    );
  }
}

// ── aperture-uq69m: Microsoft per-request email-ownership trust predicate ─────
//
// PROBLEM: Microsoft stays OUT of trustedProviders (etdx3 — a free multi-tenant
// `common` Entra app can mint a token carrying ANY email; trusting the provider
// blanket = nOAuth account takeover). But that made EVERY existing-email
// Microsoft sign-in dead-end on `account_not_linked`, including genuine users
// whose email Microsoft DOES vouch for (thacyane@hotmail — a real personal MSA).
//
// FIX (operator's refined option b): keep microsoft un-trusted, but decide
// email trust PER REQUEST from the id_token claims. better-auth's link gate
// (link-account.mjs) refuses only when `!isTrustedProvider && !emailVerified`,
// so an UNTRUSTED provider whose profile reports `emailVerified === true` LINKS.
// The microsoft provider's `getUserInfo` spreads `...mapProfileToUser(profile)`
// OVER its computed emailVerified (verified in @better-auth/core
// microsoft-entra-id.mjs, 1.6.12), and `mapProfileToUser` receives the FULL
// decoded id_token. So we compute `emailVerified` ourselves from the claims and
// let better-auth's EXISTING gate do the rest — no trustedProviders change, so
// the (A) config pin + (F) takeover-lockout test stay green.
//
// ⚠️ Cipher hard gate (nOAuth/etdx3): the email STRING alone is NOT trustworthy
// (an attacker's own Entra tenant can set a user's `email` attribute to
// victim@hotmail.com). The trust anchors are values the ISSUING TENANT cannot
// forge: the consumer `tid` (Microsoft controls that tenant) and `xms_edov`
// (Microsoft-computed domain-owner-verified).

/**
 * Microsoft's well-known CONSUMER (MSA) tenant GUID. Tokens for genuine
 * personal Microsoft accounts are issued by THIS tenant, which Microsoft
 * operates and which validates email ownership at account creation. An
 * arbitrary Azure/Entra tenant has its OWN `tid`; it CANNOT issue a token
 * stamped with this tid, so the tid — not the email string — is the anchor.
 */
const MICROSOFT_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

/**
 * Consumer email domains Microsoft owns and verifies ownership of at MSA
 * signup. Combined with the consumer `tid`, a match proves the `email` claim is
 * genuinely the signing-in user's. Being non-exhaustive is SAFE, not a hole: an
 * unlisted domain only routes a genuine consumer account to the (non-dead-end)
 * refuse path — never a security downgrade, because the `tid` gate already
 * bounds this branch to real Microsoft-issued consumer tokens.
 */
const MICROSOFT_CONSUMER_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'passport.com',
  'windowslive.com',
  'hotmail.co.uk',
  'outlook.com.br',
  'hotmail.com.br',
  'live.com.br',
]);

/**
 * aperture-uq69m — decide whether a Microsoft OIDC email is ownership-PROVEN
 * enough to implicit-link into a pre-existing same-email local account. The
 * boolean becomes the `emailVerified` we feed better-auth: `true` → auto-link
 * (untrusted + verified → link), `false` → the safe `account_not_linked` refuse
 * (which the frontend renders as a non-dead-end "already registered" message).
 *
 * TWO ownership-proving paths (either suffices):
 *   1. VERIFIED CUSTOM DOMAIN — `xms_edov === true` (Microsoft-computed "Email
 *      Domain Owner Verified"): the issuing tenant verifiably owns the email's
 *      domain. Not tenant-settable, so trustworthy for any tenant. Covers
 *      diego@bessa.digital IFF the Entra app emits the optional claim.
 *   2. CONSUMER MSA — `tid === consumer tenant` AND the email is in a
 *      Microsoft-owned consumer domain. Covers thacyane@hotmail.
 *
 * Anything else (external tenant + unverified email = the nOAuth vector) → false
 * → refuse. Ignores the incoming `email_verified` claim by design: Microsoft
 * `common` id_tokens routinely omit it or carry `false`, and a tenant-asserted
 * `email_verified` is exactly what the nOAuth attack forges — so we derive trust
 * from the unforgeable anchors above, never from a self-reported flag.
 */
export function microsoftEmailOwnershipProven(claims: {
  readonly tid?: unknown;
  readonly email?: unknown;
  readonly xms_edov?: unknown;
}): boolean {
  // Path 1 — Microsoft-verified domain owner. Emitted as a JSON boolean; some
  // token configs stringify optional claims, so accept the "1"/"true" forms too.
  const edov = claims.xms_edov;
  if (edov === true || edov === 1 || edov === '1' || edov === 'true') return true;

  // Path 2 — genuine consumer MSA (tid anchor) with a Microsoft-owned domain.
  if (claims.tid === MICROSOFT_CONSUMER_TENANT_ID) {
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    const at = email.lastIndexOf('@');
    const domain = at >= 0 ? email.slice(at + 1) : '';
    if (domain.length > 0 && MICROSOFT_CONSUMER_EMAIL_DOMAINS.has(domain)) return true;
  }

  return false;
}

/**
 * aperture-uq69m — inject the Microsoft trust predicate + empty-name fallback
 * into the microsoft provider's `mapProfileToUser`, so the SECURITY DECISION
 * lives in the engine (next to the accountLinking invariants) and a consumer
 * physically CANNOT wire a microsoft provider that skips the nOAuth gate. Every
 * other provider (google, etc.) passes through untouched — Google self-reports a
 * validated `emailVerified` and needs no override.
 *
 * `mapProfileToUser`'s return spreads OVER better-auth's provider defaults, so
 * it (a) OVERRIDES `emailVerified` with our per-request ownership predicate —
 * the flag link-account.mjs reads for implicit-link-vs-refuse — and (b)
 * backfills a NON-EMPTY display name (Microsoft can return an empty/absent
 * `name`; verified in prod for thacyane + diego), preferring the profile name,
 * then split `given_name`+`family_name`, then the email local-part.
 */
function comPreditorMicrosoft(
  socialProviders: NonNullable<BetterAuthOptions['socialProviders']>,
): NonNullable<BetterAuthOptions['socialProviders']> {
  const microsoft = socialProviders.microsoft;
  if (!microsoft) return socialProviders;
  return {
    ...socialProviders,
    microsoft: {
      ...microsoft,
      mapProfileToUser: (profile: Record<string, unknown>) => {
        const email = typeof profile.email === 'string' ? profile.email : '';
        const nomeDireto =
          typeof profile.name === 'string' && profile.name.trim().length > 0
            ? profile.name
            : [profile.given_name, profile.family_name]
                .filter((p): p is string => typeof p === 'string' && p.length > 0)
                .join(' ');
        return {
          emailVerified: microsoftEmailOwnershipProven(profile),
          name: derivarNomeExibicaoFallback(nomeDireto, email),
        };
      },
    },
  } as NonNullable<BetterAuthOptions['socialProviders']>;
}

// ── aperture-lwx2k (Camada C) gate item 5: magic-link SEND rate-limit ─────────
//
// Cipher's item-5 requirement is a rate-limit on the magic-link SEND covering
// BOTH axes (it is an email cannon without per-email):
//
//   - per-IP    → better-auth's NATIVE DB-backed limiter via `rateLimit`
//                 (storage:'database' + customRules on '/sign-in/magic-link';
//                 keyed on IP+path). Wired in the options block below. Active in
//                 production (rateLimit.enabled defaults to `isProduction`,
//                 verified in better-auth context/create-context.mjs).
//
//   - per-EMAIL → better-auth's limiter keys ONLY on IP+path
//                 (createRateLimitKey(ip, path); verified in
//                 api/rate-limiter/index.mjs) — it CANNOT key on the target
//                 email, so a single victim can be email-bombed from rotating
//                 IPs. We close that axis HERE, at the send chokepoint (the
//                 actual email IS the abuse/cost), with a DB-backed counter that
//                 REUSES the same `rate_limit` table (migration 009 — durable
//                 across deploys + shared across replicas, no Redis needed).
//
// Over the cap we SKIP the send and return normally: better-auth still emits its
// uniform success response, so there is NO account-existence / send-state oracle
// (same no-oracle posture the route itself maintains).
const MAGIC_LINK_EMAIL_WINDOW_MS = 60 * 60 * 1000; // 1h window per email
const MAGIC_LINK_EMAIL_MAX_SENDS = 5; // sends per email per window
const MAGIC_LINK_IP_WINDOW_SECONDS = 15 * 60; // 15-min window per IP
const MAGIC_LINK_IP_MAX_SENDS = 5; // sends per IP per window

/**
 * Per-EMAIL send budget for the magic-link route (gate item 5, per-email axis).
 *
 * Returns true when a send to `email` is within budget (and records it); false
 * when the per-email cap is hit (the caller MUST skip the actual send). The
 * counter row is namespaced `magic-link-email:<normalized-email>` so it never
 * collides with better-auth's own `<ip>:<path>` keys in the shared table.
 *
 * Read-then-write is non-atomic under a concurrent burst (this mirrors
 * better-auth's own onResponseRateLimit shape) — acceptable for a send-cost
 * shield: a small over-count on a simultaneous burst cannot defeat the cap's
 * intent. On a storage error we FAIL-CLOSED (skip the send) rather than open an
 * unbounded send path; in practice better-auth has already inserted the
 * verification token (proving the DB is up) before sendMagicLink runs, so the
 * catch is for truly exotic failures only.
 */
async function consumeMagicLinkEmailBudget(db: Database, email: string): Promise<boolean> {
  const key = `magic-link-email:${email.trim().toLowerCase()}`;
  const now = Date.now();
  try {
    const row = await db
      .selectFrom('rate_limit')
      .select(['count', 'last_request'])
      .where('key', '=', key)
      .executeTakeFirst();

    if (!row) {
      // First send for this email — create the row (onConflict guards the
      // race where a concurrent first-send created it between SELECT/INSERT).
      await db
        .insertInto('rate_limit')
        .values({ id: randomUUID(), key, count: 1, last_request: now })
        .onConflict((oc) => oc.column('key').doUpdateSet({ count: 1, last_request: now }))
        .execute();
      return true;
    }

    const last = Number(row.last_request);
    if (now - last > MAGIC_LINK_EMAIL_WINDOW_MS) {
      // Window elapsed — reset the counter.
      await db
        .updateTable('rate_limit')
        .set({ count: 1, last_request: now })
        .where('key', '=', key)
        .execute();
      return true;
    }
    if (row.count >= MAGIC_LINK_EMAIL_MAX_SENDS) {
      return false; // cap hit within the window — caller skips the send
    }
    await db
      .updateTable('rate_limit')
      .set({ count: row.count + 1, last_request: now })
      .where('key', '=', key)
      .execute();
    return true;
  } catch {
    return false; // counter unavailable → fail-closed (no unbounded send path)
  }
}

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
      // aperture-qcrv4 (Cipher) — supersedes the w2bty disableImplicitLinking:true.
      // POLICY: trust Google to link to a pre-existing same-email account, so a
      // returning email/password user can sign in with Google (w2bty's hard refuse
      // produced account_not_linked, blocking legit login on a consumer product).
      //
      // THREAT MODEL — why this is SAFE despite reopening implicit linking:
      // The classic pre-hijack is: attacker pre-registers victim@email via
      // email/password (unverified — eunenem has no verification flow), victim later
      // "Sign in with Google", the Google login auto-links to the ATTACKER's
      // pre-existing account, and the attacker's PASSWORD still opens it. w2bty
      // closed this by refusing all implicit linking. We reopen linking but close
      // the takeover a DIFFERENT way: the account.create.before hook below
      // INVALIDATES the local credential password the instant Google links to a
      // pre-existing account. So after a Google link, the pre-registered attacker's
      // password no longer authenticates (login rejects on !password), while the
      // legit Google user keeps access (they auth via Google, not the password).
      // The password-invalidation hook is the LOAD-BEARING safety — without it,
      // this config reopens the w2bty takeover. Do NOT remove one without the other.
      //
      // trustedProviders=['google'] (TRUSTED_OAUTH_PROVIDERS) kills better-auth's
      // untrusted-provider refuse term; requireLocalEmailVerified:false kills the
      // local-verified refuse term (required because eunenem accounts are never
      // email_verified). ⚠️ FORWARD-FRICTION: requireLocalEmailVerified is
      // @deprecated in better-auth@1.6.12 and becomes unconditional on the next
      // minor — a better-auth upgrade would RE-BLOCK linking (account_not_linked
      // returns). Re-review on any bump.
      //
      // ⚠️ etdx3: Microsoft is DELIBERATELY NOT here. With requireLocalEmailVerified
      // false, trusting Microsoft multi-tenant `common` (whose tokens carry
      // emailVerified=false and skip issuer validation) would let a free Entra
      // tenant spoof a victim's email and implicit-link into their account =
      // takeover. Only email-ownership-proving providers belong in TRUSTED. Do
      // NOT add microsoft here without solving Microsoft email verification first
      // (etdx3 option C) — and a Cipher re-review.
      accountLinking: {
        trustedProviders: [...TRUSTED_OAUTH_PROVIDERS],
        requireLocalEmailVerified: false,
      },
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
      // aperture-lwx2k gate item 5 (per-IP axis): cap magic-link SENDs per IP.
      // DB-backed (same rate_limit table), keyed on IP+path by better-auth.
      // Overrides the default /sign-in special rule for this one route. The
      // per-EMAIL axis is enforced in the magicLink sendMagicLink wrapper below
      // (better-auth's limiter cannot key on email). Active in production
      // (rateLimit.enabled defaults to isProduction).
      customRules: {
        '/sign-in/magic-link': {
          window: MAGIC_LINK_IP_WINDOW_SECONDS,
          max: MAGIC_LINK_IP_MAX_SENDS,
        },
      },
    },
    // aperture-lwx2k (Camada C) — magic-link plugin, CONDITIONAL: only spread
    // in when the consumer injected a sender (SMTP creds present). Absent → no
    // plugin → passwordless off, boots clean (mirrors the google spread).
    // TOKEN HARDENING (Cipher gate item 3, aperture-79b31):
    //   - expiresIn: 300s (5 min) — magic links are used immediately; short
    //     TTL minimises the intercept/replay window.
    //   - storeToken: 'hashed' — set EXPLICITLY (not the default); a DB leak
    //     must not expose live tokens.
    //   - single-use: better-auth consumes the token atomically on the FIRST
    //     /magic-link/verify (consumeVerificationValue; GHSA-hc7v-rggr-4hvx) —
    //     no replay window. Verified in plugins/magic-link/index.mjs.
    //   - token entropy: better-auth's default generateToken is CSPRNG
    //     (generateRandomString, 32 chars) — we rely on it deliberately.
    ...(config.sendMagicLink
      ? (() => {
          const sendMagicLink = config.sendMagicLink;
          return {
            plugins: [
              magicLink({
                expiresIn: 300,
                storeToken: 'hashed',
                sendMagicLink: async ({ email, url, token }) => {
                  // gate item 5 (per-EMAIL axis): skip the send when this email is
                  // over its send budget — preserves better-auth's uniform
                  // response (no account-existence / send-state oracle).
                  const within = await consumeMagicLinkEmailBudget(kysely, email);
                  if (!within) return;
                  await sendMagicLink({ email, url, token });
                },
              }),
            ],
          };
        })()
      : {}),
    // aperture-8655f — social providers are CONDITIONAL: only spread in when
    // the consumer injected them (both OAuth env vars present on its side).
    // Absent → key is omitted entirely → email+password-only, boots cleanly.
    // aperture-uq69m — route the microsoft provider through the engine-owned
    // email-ownership predicate (+ empty-name fallback). Pass-through for any
    // other provider. Keeps the nOAuth gate un-skippable by construction.
    ...(config.socialProviders
      ? { socialProviders: comPreditorMicrosoft(config.socialProviders) }
      : {}),
    // aperture-dm7s3 — inject the default platform id on adapter-driven user
    // creation (OAuth signup) when the row carries none. The Google profile has
    // no idPlataforma + users.id_plataforma is notNull, so without this a
    // brand-new Google signup fails at user-create. Email+password (raw Kysely
    // criarConta) bypasses BetterAuth's create path, so it never hits this hook.
    databaseHooks: {
      // aperture-dm7s3 — inject the default platform id on adapter-driven user
      // creation (OAuth signup). Only registered when the consumer injects
      // idPlataformaPadrao. SERVER-SOURCED ONLY: the platform id is ALWAYS the
      // injected server constant, NEVER read from anything in the request (OAuth
      // state/header/body / the incoming `user` object) — reading a user-
      // influenceable source would re-open the cross-tenant vector that 9tca0's
      // idPlataforma input:false closed, via the signup path. OVERRIDE
      // unconditionally; the value can only ever be `idPlataformaPadrao`.
      ...(idPlataformaPadrao
        ? {
            user: {
              create: {
                before: async (user: Record<string, unknown>) => {
                  // aperture-uq69m — provider-agnostic backstop: never persist a
                  // user with an empty display name (Microsoft can return one;
                  // the microsoft mapProfileToUser already backfills, this covers
                  // EVERY adapter-create path so no future provider strands an
                  // empty-name orphan the domain heal then can't provision).
                  const email = typeof user.email === 'string' ? user.email : '';
                  const nome = typeof user.name === 'string' ? user.name : '';
                  return {
                    data: {
                      ...user,
                      idPlataforma: idPlataformaPadrao,
                      name: derivarNomeExibicaoFallback(nome, email),
                    },
                  };
                },
              },
            },
          }
        : {}),
      // aperture-qcrv4 (Cipher) — LOAD-BEARING SAFETY for the accountLinking
      // relaxation above. When a Google account links to a user that also has a
      // local credential (email/password) account, INVALIDATE the local password
      // (set accounts.password = NULL where provider_id = 'credential'). This
      // defeats the pre-hijack takeover: a pre-registered attacker's password no
      // longer authenticates once the victim's Google links (login rejects on
      // !password), while the legit Google user keeps access (they auth via
      // Google). Runs in `before` (not `after`) so the clear happens — and can
      // ABORT the link (return false) on failure — BEFORE the Google account
      // exists: there is NEVER a "Google linked + old password still works" window.
      // No-op for non-google account creates (credential signup, brand-new Google
      // signup with no prior credential row → 0 rows updated).
      account: {
        create: {
          before: async (account: { providerId?: unknown; userId?: unknown }) => {
            // Fire for every HOOK_COVERED provider (google, microsoft) — NOT
            // just TRUSTED ones. The hook only ever NULLs a credential password,
            // which can lock out but never grant access, so covering it broadly
            // is pure defence-in-depth: if a HOOK_COVERED provider's account is
            // ever created against a user with a local credential (by trusted
            // implicit-link, or a future deliberate link), the old password is
            // invalidated. TRUSTED ⊆ HOOK_COVERED (asserted at module load), so
            // every implicit-linkable provider is necessarily covered here.
            if (
              typeof account.providerId !== 'string' ||
              !HOOK_COVERED_OAUTH_PROVIDERS.includes(
                account.providerId as HookCoveredOAuthProvider,
              ) ||
              typeof account.userId !== 'string'
            ) {
              return;
            }
            try {
              await kysely
                .updateTable('accounts')
                .set({ password: null })
                .where('user_id', '=', account.userId)
                .where('provider_id', '=', 'credential')
                .execute();
            } catch {
              // Fail-closed: if the password could not be invalidated, ABORT the
              // link rather than leave a usable pre-existing password alongside a
              // freshly-linked Google identity (that would be the takeover state).
              // The user can retry Google (this before-hook re-fires) to recover.
              return false;
            }
            return;
          },
        },
      },
      // aperture-lwx2k / 79b31 (Cipher KEYSTONE) — magic-link password
      // invalidation. The OAuth account.create.before above covers the
      // link-account path; this covers the OTHER email-ownership-proving path:
      // magic-link sign-in authenticates an existing user WITHOUT an
      // account.create event (it sets users.email_verified=true then creates a
      // session), so the OAuth hook never fires. Without THIS hook a
      // pre-registered attacker's password survives the victim's magic-link
      // login = account takeover.
      //
      // MECHANISM (Cipher-approved over user.update.before, which is
      // identity-blind + non-transactional): key on the SESSION being created.
      // session.create.before receives the session data WITH userId, runs
      // BEFORE the session row is inserted, and `return false` aborts the
      // session (magic-link's `if (!session) redirectWithError` → NO cookie) —
      // fail-closed BEFORE authentication completes.
      //
      // INVARIANT (provider-agnostic, NOT magic-link-specific): any session for
      // a user whose email is verified must not coexist with a live local
      // credential password. We key on STATE (users.email_verified===true), not
      // a fragile "came-from-magic-link" guard:
      //   - magic-link verify just set email_verified=true → NULL the password.
      //   - OAuth: account.create.before already nulled it → 0 rows, no-op.
      //   - pure password user (never verified): email_verified=FALSE → SKIP →
      //     password preserved (coexistence login is NOT broken). New credential
      //     rows are created email_verified=false, so normal password login is
      //     never touched.
      //   - email_verified=true + a live password only co-occurs in the takeover
      //     state (or the very magic-link session establishing verification) →
      //     nulling is exactly the fix. Idempotent + self-healing: every
      //     session.create re-enforces it (0 rows once there's no live password).
      //
      // ⚠️ FORWARD-FRICTION (Cipher — re-review REQUIRED if any of these land):
      // enabling the email-otp plugin, core emailVerification
      // (sendVerificationEmail), the admin plugin, OR any direct
      // updateUser({emailVerified:true}) that is NOT immediately followed by a
      // session.create — each could flip email_verified=true WITHOUT a session
      // to trip this hook, leaving a one-session-takeover window on the
      // attacker's NEXT login. autoSignInAfterVerification:true creates a
      // session (covered); false does not (window). Trip on this before adding.
      session: {
        create: {
          before: async (session: { userId?: unknown }) => {
            if (typeof session.userId !== 'string') return;
            // STATE gate: only verified-email users. Pure password users are
            // email_verified=false → skip → their password is preserved.
            const usuario = await kysely
              .selectFrom('users')
              .select('email_verified')
              .where('id', '=', session.userId)
              .executeTakeFirst();
            if (!usuario?.email_verified) return;
            try {
              // COND C: ALL credential rows for this user, never OAuth rows.
              // Mirrors the account.create.before query exactly.
              await kysely
                .updateTable('accounts')
                .set({ password: null })
                .where('user_id', '=', session.userId)
                .where('provider_id', '=', 'credential')
                .execute();
            } catch {
              // COND B (fail-closed): if the NULL fails, ABORT this session
              // rather than authenticate while a live credential survives. The
              // user retries (the hook re-fires); the state-keyed gate
              // self-heals on the next session.create.
              return false;
            }
            return;
          },
        },
      },
    },
  } satisfies BetterAuthOptions;

  return betterAuth(options);
}

/** The fully-constructed Auth instance returned by `criarAuth`. */
export type Auth = ReturnType<typeof criarAuth>;
