import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { AuthServiceBetterAuth } from '../../src/adapters/usuario/auth-service.better-auth.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';

/**
 * SECURITY-PINNING TEST — Google-OAuth account-linking collision gate
 * (aperture-8655f / aperture-w2bty — Cipher's account-takeover gate).
 *
 * ============================================================================
 * READ THIS FIRST — HONEST COVERAGE NOTE (the test of the *real* reality)
 * ============================================================================
 * The hardening we were asked to pin lives in
 * `src/adapters/usuario/criar-auth.ts`:
 *
 *     account: {
 *       accountLinking: { trustedProviders: [], disableImplicitLinking: true },
 *     }
 *
 * In better-auth@1.6.12 this config makes `handleOAuthUserInfo`
 * (dist/oauth2/link-account.mjs) SHORT-CIRCUIT to
 * `{ error: "account not linked", data: null }` BEFORE `createSession`
 * when a first Google sign-in collides with an existing local account —
 * which is the takeover refusal we want to lock in.
 *
 * HISTORY (the casing bug, now FIXED — aperture-bq2c9, tip e9a47f0):
 * While building this test the OAuth callback could NOT REACH the linking
 * decision at all. better-auth@1.6.12's data-layer does not honour
 * `database.casing: 'snake'` for queries through its OWN adapter, so every
 * adapter query emitted CAMEL-CASE column names (`accountId`, `expiresAt`, …)
 * absent from the snake_cased migration-009 schema (Postgres `42703 column
 * does not exist`). Init 500'd (`createVerificationValue` wrote `expiresAt`),
 * the callback 500'd at state-parse and again at `findOAuthUser`
 * (`accounts.accountId`). The gate was masked behind those 500s.
 *
 * THE FIX (Rex, e9a47f0): criar-auth.ts now declares explicit per-field
 * `fieldName` maps (`accountId → account_id`, `expiresAt → expires_at`, etc.)
 * so the better-auth adapter queries the snake_case columns directly. The
 * init step and the Google OAuth callback now run end-to-end against the real
 * schema — and the `disableImplicitLinking` gate is REACHABLE for the first
 * time.
 *
 * OBSERVED post-fix behaviour (this is now PINNED, verified end-to-end
 * against e9a47f0): a colliding existing-email Google sign-in is REFUSED at
 * the gate — `handleOAuthUserInfo` short-circuits to "account not linked"
 * BEFORE `createSession`, the callback redirects to
 *   /oauth-error?error=account_not_linked
 * NO session cookie is minted, NO `sessions` row is written, and NO implicit
 * `google` account is linked to the victim's row (the only `accounts` row
 * stays the original `credential` one). This is the genuine takeover refusal
 * we set out to lock in.
 *
 * WHAT THIS FILE PINS (all real, nothing faked):
 *   (A)  SOURCE CONFIG: `criarAuth` must emit
 *        `account.accountLinking.disableImplicitLinking === true` and empty
 *        `trustedProviders`. Removing it re-opens the takeover gate. Durable
 *        regression guard for the gate config itself.
 *   (B)  REAL CALLBACK: the colliding Google sign-in mints NO session / NO
 *        implicit link for the existing local user AND redirects to the
 *        genuine `error=account_not_linked` refusal (the gate, reachable
 *        post-fix). If this ever flips to success/session, that is an
 *        account-takeover regression — do NOT paper over it.
 *   (B2) INIT NO-500: `POST /api/auth/sign-in/social` no longer 500s — it
 *        returns a Google authorize redirect (proves the casing fix reached
 *        the init path too).
 *   (C)  Composite UNIQUE `users(id_plataforma, email)` — defence-in-depth
 *        (raw Kysely).
 *
 * The ONLY thing mocked anywhere below is Google's OUTBOUND token endpoint
 * (`https://oauth2.googleapis.com/token`). The state cookie + verification
 * row are reconstructed exactly as better-auth's init step writes them, so
 * the callback runs its REAL state-parse + REAL (now-fixed) data-layer +
 * REAL linking gate — nothing about the security decision is faked.
 */

const SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
const BASE_URL = 'http://localhost:3001';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SUCCESS_CALLBACK_URL = `${BASE_URL}/dashboard`;
const ERROR_CALLBACK_URL = `${BASE_URL}/oauth-error`;

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

/**
 * Build the REAL engine auth via `criarAuth` — so the pinned
 * `accountLinking` config flows through unchanged. We do NOT reconstruct
 * the options ourselves (that would defeat the pin). `useSecureCookies:
 * false` so cookies work over plain http in the test.
 */
function buildAuth() {
  return criarAuth(testDb.db, {
    secret: SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    sendResetPassword: async () => {
      /* no-op for this test */
    },
    useSecureCookies: false,
    socialProviders: {
      google: {
        clientId: 'test-google-client-id',
        clientSecret: 'test-google-client-secret',
      },
    },
  });
}

/**
 * PRODUCTION-FIDELITY auth variant for the happy-path (D) test
 * (aperture-dm7s3). The (A)/(B)/(B2)/(C) tests above intentionally build auth
 * WITHOUT `idPlataformaPadrao` — so the dm7s3 user.create.before hook is NOT
 * registered, which is fine for the REFUSE path (no user is ever created).
 *
 * But the brand-new-user SUCCESS path is exactly the scenario dm7s3 ships for:
 * the Google profile carries NO idPlataforma + `users.id_plataforma` is notNull,
 * so without the injected server constant the create would violate the
 * constraint. eunenem-server's real config
 * (`apps/eunenem-server/server/auth/setup.ts` → `idPlataformaPadrao:
 * ID_PLATAFORMA_EUNENEM`) pairs the google provider WITH `idPlataformaPadrao`,
 * which registers the hook. This variant mirrors that EXACT production pairing
 * so the (D) test drives the real callback against the same config prod runs —
 * nothing extra stubbed, only the addition of the server constant prod injects.
 */
function buildAuthWithPlatformId() {
  return criarAuth(testDb.db, {
    secret: SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    sendResetPassword: async () => {
      /* no-op for this test */
    },
    useSecureCookies: false,
    // aperture-dm7s3 — the server constant prod injects on OAuth user-create.
    idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
    socialProviders: {
      google: {
        clientId: 'test-google-client-id',
        clientSecret: 'test-google-client-secret',
      },
    },
  });
}

/**
 * better-call's signed-cookie format, reproduced with node:crypto:
 *   encodeURIComponent(value + "." + base64(HMAC-SHA256(value, secret)))
 * Used to reconstruct the signed `state` cookie that the (bug-broken)
 * init step would have set, so the REAL callback's state-parse runs.
 */
function signStateCookie(value: string): string {
  const sig = createHmac('sha256', SECRET).update(value).digest('base64');
  return encodeURIComponent(`${value}.${sig}`);
}

/** A well-formed (unsigned) JWT carrying Google profile claims. */
function makeIdToken(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
  const payload = b64({
    iss: 'https://accounts.google.com',
    aud: 'test-google-client-id',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  });
  return `${header}.${payload}.sig`;
}

/** Mock ONLY Google's outbound token endpoint. Returns a restore fn. */
function mockGoogleToken(idTokenClaims: Record<string, unknown>): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.startsWith(GOOGLE_TOKEN_ENDPOINT)) {
      return new Response(
        JSON.stringify({
          access_token: 'ya29.fake-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'email profile openid',
          id_token: makeIdToken(idTokenClaims),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // Anything else hits the real fetch so a stray network dependency
    // fails loudly instead of being silently faked.
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/**
 * Reconstruct the cross-request OAuth state the init step establishes
 * (database strategy = verification row + signed `state` cookie), then
 * drive the REAL callback. We are NOT faking the linking decision — we are
 * reconstructing the pre-callback CSRF state so the REAL callback executes
 * its REAL data-layer (which is what surfaces the casing bug).
 */
async function driveRealCallback(
  auth: ReturnType<typeof buildAuth>,
  opts: { idTokenClaims: Record<string, unknown> },
): Promise<Response> {
  const state = randomUUID().replace(/-/g, '');
  const statePayload = {
    callbackURL: SUCCESS_CALLBACK_URL,
    codeVerifier: 'a'.repeat(43),
    errorURL: ERROR_CALLBACK_URL,
    expiresAt: Date.now() + 600_000,
    oauthState: state,
  };
  await testDb.db
    .insertInto('verifications')
    .values({
      id: randomUUID(),
      identifier: state,
      value: JSON.stringify(statePayload),
      expires_at: new Date(Date.now() + 600_000),
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();

  const restore = mockGoogleToken(opts.idTokenClaims);
  try {
    const url = new URL(`${BASE_URL}/api/auth/callback/google`);
    url.searchParams.set('code', 'fake-authorization-code');
    url.searchParams.set('state', state);
    return await auth.handler(
      new Request(url.toString(), {
        method: 'GET',
        headers: { cookie: `better-auth.state=${signStateCookie(state)}` },
        redirect: 'manual',
      }),
    );
  } finally {
    restore();
  }
}

async function sessionCountForUser(userId: string): Promise<number> {
  const rows = await testDb.db
    .selectFrom('sessions')
    .select(({ fn }) => fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .execute();
  return Number(rows[0]?.n ?? 0);
}

function setsSessionCookie(res: Response): boolean {
  return (res.headers.getSetCookie?.() ?? []).some((c) => c.includes('session_token'));
}

describe('Google-OAuth account-linking collision gate (aperture-8655f / aperture-w2bty)', () => {
  beforeEach(async () => {
    await truncateBetterAuthTables(testDb.db);
  });

  afterEach(async () => {
    // Defensive: ensure no test leaves a patched global fetch behind.
  });

  // --------------------------------------------------------------------------
  // (A) SOURCE-CONFIG PIN — the durable regression guard for the gate.
  // --------------------------------------------------------------------------
  it('(A) PIN: criarAuth emits accountLinking.disableImplicitLinking=true', () => {
    const auth = buildAuth();
    // `auth.options` is the resolved BetterAuthOptions object criarAuth built.
    const accountLinking = (
      auth as unknown as {
        options?: { account?: { accountLinking?: Record<string, unknown> } };
      }
    ).options?.account?.accountLinking;

    expect(
      accountLinking,
      'criar-auth.ts must declare an account.accountLinking block',
    ).toBeDefined();
    expect(
      accountLinking?.disableImplicitLinking,
      'REMOVING disableImplicitLinking re-opens the OAuth→local account-takeover gate (aperture-w2bty). Do not.',
    ).toBe(true);
    expect(
      accountLinking?.trustedProviders,
      'trustedProviders must stay empty — a trusted provider bypasses the gate',
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // (B) REAL CALLBACK — colliding Google sign-in mints NO session for the
  //     existing local user and is REFUSED at the disableImplicitLinking gate
  //     with error=account_not_linked (reachable post-casing-fix, e9a47f0).
  // --------------------------------------------------------------------------
  it('(B) colliding Google sign-in mints NO session for the existing local user', async () => {
    const auth = buildAuth();
    const authService = new AuthServiceBetterAuth(testDb.db);

    const existingUserId = randomUUID();
    const email = 'collision-victim@example.com';
    await authService.criarConta({
      idUsuario: existingUserId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: 'the-real-owners-password',
      nome: 'Collision Victim',
    });

    // Google reports the SAME email, VERIFIED — the takeover-attempt shape.
    const res = await driveRealCallback(auth, {
      idTokenClaims: {
        sub: 'google-attacker-subject-0001',
        email,
        email_verified: true,
        name: 'Not The Real Owner',
      },
    });

    // THE LOAD-BEARING SECURITY ASSERTION (holds regardless of WHY):
    // the attacker is NOT logged in as the victim.
    expect(setsSessionCookie(res), 'no session cookie may be minted').toBe(false);
    expect(
      await sessionCountForUser(existingUserId),
      'no session row may exist for the pre-existing local user',
    ).toBe(0);

    // And no Google account was implicitly linked to the victim's row.
    const linkedGoogle = await testDb.db
      .selectFrom('accounts')
      .select('id')
      .where('user_id', '=', existingUserId)
      .where('provider_id', '=', 'google')
      .execute();
    expect(linkedGoogle, 'no implicit google link may be created').toHaveLength(0);

    // The callback must NOT have succeeded into a session/dashboard.
    const location = res.headers.get('location') ?? '';
    expect([302, 303, 307]).toContain(res.status);
    expect(location, 'must not redirect to the success/dashboard URL').not.toContain(
      'dashboard',
    );

    // GENUINE GATE PIN — post-casing-fix (aperture-bq2c9, tip e9a47f0).
    // The casing bug is FIXED: better-auth's own adapter now queries the
    // snake_case columns via the per-field `fieldName` maps Rex added to
    // criar-auth.ts, so the callback no longer 500s at the
    // verifications/accounts column mismatch. The colliding Google sign-in
    // now REACHES the `disableImplicitLinking` decision and is REFUSED:
    // `handleOAuthUserInfo` short-circuits to "account not linked" BEFORE
    // `createSession`, redirecting the callback to
    //   /oauth-error?error=account_not_linked
    // (OBSERVED end-to-end against e9a47f0, aperture-sunl9/izzy-sbje8). This
    // is the FIRST time the takeover gate is exercised end-to-end — pre-fix
    // it was masked behind the 500. The no-session / no-link / no-dashboard
    // assertions above now hold for the GATE reason, not the casing bug.
    //
    //   ⚠️ If this assertion ever flips to a success/dashboard redirect OR a
    //   session/google-link appears above, the gate has REGRESSED into a real
    //   account-takeover (aperture-w2bty). Do NOT paper over it.
    expect(
      location,
      'POST-FIX reality: the disableImplicitLinking gate must REFUSE the ' +
        'colliding sign-in with error=account_not_linked. A success/session ' +
        'here is an account-takeover (aperture-w2bty).',
    ).toContain('error=account_not_linked');
  });

  // --------------------------------------------------------------------------
  // (B2) INIT NO-500 — complementary post-casing-fix pin: the social sign-in
  //      init step (which used to 500 on `createVerificationValue` writing
  //      `expiresAt` instead of `expires_at`) now succeeds and hands back a
  //      Google authorize redirect. Proves the casing fix reached the init
  //      path too, so the callback above runs against a real init flow.
  // --------------------------------------------------------------------------
  it('(B2) POST /api/auth/sign-in/social init no longer 500s — returns a Google redirect', async () => {
    const auth = buildAuth();
    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'google', callbackURL: SUCCESS_CALLBACK_URL }),
      }),
    );

    // Must NOT be the casing-bug 500.
    expect(res.status, 'social-init must not 500 (casing bug fixed)').not.toBe(500);
    expect([200, 302, 303, 307]).toContain(res.status);

    // The init resolves to a Google authorize URL (better-auth returns it in
    // the JSON body as `{ url, redirect: true }` for a 200, or via Location
    // for a 30x). Either way it must point at Google's OAuth endpoint.
    const body = await res.clone().text();
    const location = res.headers.get('location') ?? '';
    const redirectTarget = location || body;
    expect(
      redirectTarget,
      'init must resolve to a Google OAuth authorize URL, not an error page',
    ).toContain('accounts.google.com/o/oauth2');
    expect(redirectTarget, 'init must not surface an internal_server_error').not.toContain(
      'internal_server_error',
    );
  });

  // --------------------------------------------------------------------------
  // (D) REAL CALLBACK — HAPPY PATH (aperture-dm7s3). A brand-new Google
  //     identity (fresh email + fresh sub, NO pre-existing user row) signs in
  //     for the first time. This is the SUCCESS counterpart to (B)'s refusal:
  //     the OAuth callback must CREATE a user, inject the server platform id
  //     via the dm7s3 user.create.before hook, link a `google` accounts row,
  //     establish a session (cookie + sessions row), and redirect to the
  //     success/dashboard callbackURL — NOT /oauth-error.
  //
  //     ⚠️ OBSERVE, DON'T ASSUME — this is the FIRST end-to-end proof the
  //     happy path works post-dm7s3. If NO user is created, if id_plataforma
  //     is null/wrong (≠ ID_PLATAFORMA_EUNENEM), if no session is established,
  //     or if it redirects to oauth-error → that is a FINDING (the gate is NOT
  //     satisfied). id_plataforma being null/wrong on a created user would be a
  //     multi-tenancy data-integrity bug. Do NOT massage these to pass.
  // --------------------------------------------------------------------------
  it('(D) brand-new Google account → user created with id_plataforma=EUNENEM + session established', async () => {
    // Production-fidelity auth: google provider + idPlataformaPadrao, exactly
    // as eunenem-server wires it — so the dm7s3 create.before hook is live.
    const auth = buildAuthWithPlatformId();

    const freshEmail = `brand-new-google-user-${randomUUID()}@example.com`;
    const freshSub = `google-fresh-subject-${randomUUID()}`;

    // Sanity: NO user exists for this email before the callback.
    const pre = await testDb.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', freshEmail)
      .execute();
    expect(pre, 'precondition: no pre-existing user for the fresh email').toHaveLength(0);

    // Drive the REAL /api/auth/callback/google. Mock ONLY Google's token
    // endpoint (returns a verified id_token for the fresh identity).
    const res = await driveRealCallback(auth, {
      idTokenClaims: {
        sub: freshSub,
        email: freshEmail,
        email_verified: true,
        name: 'Brand New Google User',
      },
    });

    // (a) A NEW user row exists for the fresh email, and its id_plataforma is
    //     the server constant the dm7s3 hook injects (NOT null, NOT wrong).
    const createdUsers = await testDb.db
      .selectFrom('users')
      .select(['id', 'email', 'id_plataforma'])
      .where('email', '=', freshEmail)
      .execute();
    expect(
      createdUsers,
      'the OAuth callback must CREATE exactly one user for the brand-new Google identity. ' +
        'ZERO here means the happy path is broken (user-create failed) — a FINDING.',
    ).toHaveLength(1);
    const createdUser = createdUsers[0]!;
    expect(
      createdUser.id_plataforma,
      'the dm7s3 user.create.before hook must inject id_plataforma = ID_PLATAFORMA_EUNENEM ' +
        'on the OAuth-created user. null/wrong here is a multi-tenancy data-integrity bug — a FINDING.',
    ).toBe(ID_PLATAFORMA_EUNENEM);

    // (b) A SESSION is established — cookie IS set AND a sessions row exists.
    expect(
      setsSessionCookie(res),
      'a session cookie MUST be minted on successful OAuth signup. Absent = no session = FINDING.',
    ).toBe(true);
    expect(
      await sessionCountForUser(createdUser.id),
      'at least one sessions row MUST exist for the newly-created user. Zero = no session = FINDING.',
    ).toBeGreaterThanOrEqual(1);

    // (c) The callback redirects to the SUCCESS callbackURL (dashboard),
    //     NOT to /oauth-error.
    const location = res.headers.get('location') ?? '';
    expect([302, 303, 307]).toContain(res.status);
    expect(
      location,
      'a successful OAuth signup must redirect to the success/dashboard callbackURL. ' +
        'A redirect to oauth-error means the happy path failed — a FINDING.',
    ).toContain('dashboard');
    expect(
      location,
      'must NOT redirect to oauth-error on a brand-new-user happy path',
    ).not.toContain('oauth-error');

    // (d) A `google` accounts row is linked to the new user (the OAuth account
    //     record). provider_id='google', user_id=the created user.
    const googleAccounts = await testDb.db
      .selectFrom('accounts')
      .select(['id', 'provider_id', 'account_id'])
      .where('user_id', '=', createdUser.id)
      .where('provider_id', '=', 'google')
      .execute();
    expect(
      googleAccounts,
      'a google accounts row must be linked to the brand-new user (the OAuth account record).',
    ).toHaveLength(1);
    expect(googleAccounts[0]!.account_id, 'the google account must carry the Google sub').toBe(
      freshSub,
    );
  });

  // --------------------------------------------------------------------------
  // (C) Composite UNIQUE — the defence-in-depth layer that works today.
  // --------------------------------------------------------------------------
  it('(C) users(id_plataforma, email) composite UNIQUE bounds duplicate creation', async () => {
    const authService = new AuthServiceBetterAuth(testDb.db);
    const email = 'composite-unique@example.com';

    await authService.criarConta({
      idUsuario: randomUUID(),
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: 'first',
      nome: 'First',
    });

    await expect(
      authService.criarConta({
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email,
        senha: 'second',
        nome: 'Second',
      }),
    ).rejects.toThrow();

    const rows = await testDb.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .where('id_plataforma', '=', ID_PLATAFORMA_EUNENEM)
      .execute();
    expect(rows, 'composite UNIQUE keeps exactly one row').toHaveLength(1);
  });
});
