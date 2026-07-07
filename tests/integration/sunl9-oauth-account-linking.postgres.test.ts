import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../../src/adapters/usuario/auth-service.better-auth.js';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { NomeExibicaoUsuarioSchema } from '../../src/domain/usuario/value-objects/nome-exibicao-usuario.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';

/**
 * SECURITY-PINNING TEST — Google-OAuth account-linking + password-invalidation
 * (aperture-8655f / aperture-w2bty / aperture-qcrv4 — Cipher's takeover gate,
 * NEW MODEL).
 *
 * ============================================================================
 * READ THIS FIRST — THE MODEL THIS FILE PINS (aperture-qcrv4, the CURRENT fix)
 * ============================================================================
 * The hardening this file pins lives in `src/adapters/usuario/criar-auth.ts`.
 *
 * HISTORY — the OLD w2bty model (SUPERSEDED, do NOT re-pin it):
 *     account: { accountLinking: { trustedProviders: [], disableImplicitLinking: true } }
 * w2bty hard-REFUSED implicit linking: a returning email/password user who
 * clicked "Sign in with Google" got `error=account_not_linked` and could not
 * log in. That blocked legitimate login on a consumer product.
 *
 * THE NEW qcrv4 model (CURRENT — what this file pins):
 *     account: {
 *       accountLinking: { trustedProviders: ['google'], requireLocalEmailVerified: false },
 *     }
 *   + an `account.create.before` databaseHook that, when a `google` account is
 *     created (links to a user), runs
 *       UPDATE accounts SET password = NULL
 *       WHERE user_id = <that user> AND provider_id = 'credential'
 *     FAIL-CLOSED (returns false to ABORT the link on error).
 *
 * The config RELAXES linking (an existing email+password user CAN now sign in
 * with Google and it LINKS — the old hard-refuse is gone). The compensating
 * control is the password-NULLing hook. Together they enforce the invariant:
 *   THERE IS NEVER A "Google linked + old local password still works" STATE.
 *
 * Why that DEFEATS the w2bty pre-hijack takeover: the attacker pre-registers
 * victim@email via email/password (eunenem has no email-verification flow, so
 * the row is unverified), the victim later "Sign in with Google" → the link
 * fires → the attacker's credential password is NULLed → the attacker's
 * password no longer authenticates (`iniciarSessao` rejects on the NULL hash),
 * while the legit Google user keeps access (they auth via Google, not a
 * password). The password-invalidation is the LOAD-BEARING safety; without it
 * this config reopens the takeover.
 *
 * WHAT THIS FILE PINS (all real, nothing faked):
 *   (A)  SOURCE CONFIG: `criarAuth` must emit
 *        `account.accountLinking.trustedProviders` deep-equal `['google']` AND
 *        `requireLocalEmailVerified === false`. Durable regression guard for
 *        the relaxed-linking config itself.
 *   (B)  REAL CALLBACK — COLLISION NOW LINKS: a colliding existing-email Google
 *        sign-in LINKS — a session IS established (cookie + sessions row) and a
 *        `google` accounts row now exists for the user. Redirect is the
 *        success/dashboard URL, NOT `account_not_linked`.
 *   (b)  ⭐ LOAD-BEARING + NON-VACUOUS PASSWORD-INVALIDATION PROOF. Three
 *        distinct asserts: (1) BEFORE the Google link, the local password
 *        AUTHENTICATES (`iniciarSessao` SUCCEEDS) — the control that proves the
 *        password was valid pre-link; (2) AFTER the link, the credential
 *        accounts.password IS NULL; (3) AFTER the link, the SAME local password
 *        is REJECTED (`iniciarSessao` throws). The BEFORE-succeeds /
 *        AFTER-rejects contrast is what makes this NON-VACUOUS: it proves the
 *        LINK killed the password, not that the password never worked.
 *   (B2) INIT NO-500: `POST /api/auth/sign-in/social` returns a Google
 *        authorize redirect (proves the casing fix reached the init path too).
 *   (D)  NO-REGRESSION HAPPY PATH: a brand-new Google email (no pre-existing
 *        credential account) still creates a fresh user with
 *        id_plataforma=EUNENEM + session.
 *   (C)  Composite UNIQUE `users(id_plataforma, email)` — defence-in-depth
 *        (raw Kysely).
 *
 * The ONLY thing mocked anywhere below is Google's OUTBOUND token endpoint
 * (`https://oauth2.googleapis.com/token`). The state cookie + verification
 * row are reconstructed exactly as better-auth's init step writes them, so
 * the callback runs its REAL state-parse + REAL data-layer + REAL linking +
 * REAL password-invalidation hook — nothing about the security decision is
 * faked.
 *
 * ⚠️ REGRESSION-GUARD (the whole point of (B)+(b)): if the credential password
 * is NOT cleared after a Google link, OR the old password STILL authenticates
 * post-link, the w2bty pre-hijack takeover is REOPENED. (b) pins loudly so a
 * config/hook regression (removing trustedProviders, or the account.create.
 * before hook, or a better-auth bump that re-blocks linking) breaks this test.
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

// ── aperture-etdx3: Microsoft-OAuth harness (attacker-lockout proof) ─────────
// Microsoft's callback code-flow resolves the profile via getUserInfo →
// decodeJwt (NO signature/JWKS verification, same as Google here), so we can
// drive the REAL callback with a mocked token endpoint + a decode-only id_token.
const MICROSOFT_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_GRAPH = 'https://graph.microsoft.com/';

/** Auth with the REAL config + the Microsoft provider registered. */
function buildAuthWithMicrosoft() {
  return criarAuth(testDb.db, {
    secret: SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    sendResetPassword: async () => {
      /* no-op for this test */
    },
    useSecureCookies: false,
    idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
    socialProviders: {
      microsoft: {
        clientId: 'test-microsoft-client-id',
        clientSecret: 'test-microsoft-client-secret',
        tenantId: 'common',
      },
    },
  });
}

/** A well-formed (unsigned) JWT carrying Microsoft profile claims. */
function makeMicrosoftIdToken(claims: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
  const payload = b64({
    iss: 'https://login.microsoftonline.com/common/v2.0',
    aud: 'test-microsoft-client-id',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
    ...claims,
  });
  return `${header}.${payload}.sig`;
}

/**
 * Mock Microsoft's token endpoint (returns the attacker-controlled id_token)
 * AND the Graph photo endpoint (getUserInfo betterFetches it — return non-ok so
 * the photo block skips without a real outbound call). Returns a restore fn.
 */
function mockMicrosoftToken(idTokenClaims: Record<string, unknown>): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.startsWith(MICROSOFT_TOKEN_ENDPOINT)) {
      return new Response(
        JSON.stringify({
          access_token: 'fake-ms-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email User.Read',
          id_token: makeMicrosoftIdToken(idTokenClaims),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.startsWith(MICROSOFT_GRAPH)) {
      // No profile photo — skip cleanly (non-ok, no throw, no real network).
      return new Response(null, { status: 404 });
    }
    // Anything else hits the real fetch so a stray dependency fails loudly.
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** Drive the REAL Microsoft callback (mirrors driveRealCallback). */
async function driveRealMicrosoftCallback(
  auth: ReturnType<typeof buildAuthWithMicrosoft>,
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

  const restore = mockMicrosoftToken(opts.idTokenClaims);
  try {
    const url = new URL(`${BASE_URL}/api/auth/callback/microsoft`);
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

describe('Google-OAuth account-linking + password-invalidation (aperture-8655f / aperture-w2bty / aperture-qcrv4)', () => {
  beforeEach(async () => {
    await truncateBetterAuthTables(testDb.db);
  });

  afterEach(async () => {
    // Defensive: ensure no test leaves a patched global fetch behind.
  });

  // --------------------------------------------------------------------------
  // (A) SOURCE-CONFIG PIN — the durable regression guard for the NEW qcrv4
  //     relaxed-linking config.
  // --------------------------------------------------------------------------
  it('(A) PIN: criarAuth emits accountLinking.trustedProviders=["google"] (microsoft NOT trusted) + requireLocalEmailVerified=false', () => {
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
    // aperture-qcrv4: linking is RELAXED for GOOGLE only — Google can
    // implicit-link to a same-email account, the takeover closed by the
    // password-invalidation hook (proven in (b)).
    //
    // aperture-etdx3 (SECURITY): trustedProviders is GOOGLE-ONLY on purpose.
    // Microsoft must NOT be here: a free multi-tenant `common` Entra app can
    // mint a token carrying any email with emailVerified=false (issuer check
    // skipped for `common`), and better-auth implicit-links trusted providers
    // REGARDLESS of emailVerified (callback.mjs) → a Microsoft-in-trusted
    // config = account takeover. Only email-ownership-proving providers belong
    // in trustedProviders. Microsoft stays HOOK_COVERED (password-NULL) but
    // un-trusted; proven behaviourally in (F). This deep-equal pins the EXACT
    // trusted set — adding microsoft (or any unverified-email provider) here
    // is the security regression this guard catches.
    expect(
      accountLinking?.trustedProviders,
      'trustedProviders must deep-equal ["google"] — microsoft must NOT be trusted (etdx3 takeover fix)',
    ).toEqual(['google']);
    expect(
      accountLinking?.requireLocalEmailVerified,
      'requireLocalEmailVerified must be false — eunenem accounts are never ' +
        'email_verified, so true would re-block the google link (account_not_linked).',
    ).toBe(false);
  });

  // --------------------------------------------------------------------------
  // (B) REAL CALLBACK — COLLISION NOW LINKS (flipped from w2bty's refuse).
  //     A colliding existing-email Google sign-in LINKS: a session IS
  //     established (cookie + sessions row) and a `google` accounts row now
  //     exists for the user. Redirect is the success/dashboard URL, NOT
  //     account_not_linked.
  //
  //     This MUST use the production-fidelity auth (google provider +
  //     idPlataformaPadrao) so BOTH databaseHooks are live — the dm7s3
  //     user.create.before (irrelevant here, no user is created) AND the
  //     qcrv4 account.create.before password-invalidation hook (load-bearing
  //     for (b)). buildAuth() (no idPlataformaPadrao) would still register the
  //     account hook, but we mirror prod exactly to keep (B) and (b) on the
  //     same config the server runs.
  // --------------------------------------------------------------------------
  it('(B) colliding Google sign-in LINKS — session established + google account linked', async () => {
    const auth = buildAuthWithPlatformId();
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

    // Google reports the SAME email, VERIFIED — the collision shape.
    const res = await driveRealCallback(auth, {
      idTokenClaims: {
        sub: 'google-collision-subject-0001',
        email,
        email_verified: true,
        name: 'Google Identity',
      },
    });

    // It LINKS — a session IS minted for the pre-existing user.
    expect(
      setsSessionCookie(res),
      'aperture-qcrv4: the relaxed-linking policy LINKS the google sign-in to ' +
        'the existing user, so a session cookie MUST be minted. Absent = the ' +
        'link did NOT fire (config/better-auth regression) — a FINDING.',
    ).toBe(true);
    expect(
      await sessionCountForUser(existingUserId),
      'a sessions row MUST exist for the pre-existing local user after the link',
    ).toBeGreaterThanOrEqual(1);

    // A google account is now linked to the existing user's row.
    const linkedGoogle = await testDb.db
      .selectFrom('accounts')
      .select(['id', 'account_id'])
      .where('user_id', '=', existingUserId)
      .where('provider_id', '=', 'google')
      .execute();
    expect(
      linkedGoogle,
      'a google accounts row MUST now be linked to the existing user (the link fired)',
    ).toHaveLength(1);

    // The callback redirects to SUCCESS/dashboard — NOT account_not_linked.
    const location = res.headers.get('location') ?? '';
    expect([302, 303, 307]).toContain(res.status);
    expect(
      location,
      'aperture-qcrv4: a successful link must redirect to the success/dashboard URL',
    ).toContain('dashboard');
    expect(
      location,
      'must NOT redirect to account_not_linked (that was the OLD w2bty refuse model)',
    ).not.toContain('account_not_linked');
  });

  // --------------------------------------------------------------------------
  // (b) ⭐ LOAD-BEARING + NON-VACUOUS PASSWORD-INVALIDATION PROOF (aperture-qcrv4).
  //
  //     This is the assertion Cipher reviews hardest. It proves the qcrv4
  //     account.create.before hook genuinely KILLS the pre-existing local
  //     password the instant Google links — which is what defeats the w2bty
  //     pre-hijack takeover (attacker pre-registers victim's email+password;
  //     victim later signs in with Google → link fires → attacker's password
  //     is NULLed → attacker's password no longer authenticates).
  //
  //     THREE DISTINCT, ORDERED ASSERTS make this NON-VACUOUS:
  //       1. CONTROL (BEFORE the link): the local password AUTHENTICATES —
  //          iniciarSessao SUCCEEDS (returns a session token). Proves the
  //          password was valid pre-link.
  //       2. (drive the Google callback to LINK — same as (B))
  //       3a. AFTER: the credential accounts.password IS NULL (the hook ran).
  //       3b. AFTER: the SAME local password is REJECTED — iniciarSessao
  //           throws. (iniciarSessao's `if (!row?.password)` no-user branch
  //           fires on the NULL hash → UsuarioInputInvalidoError.)
  //
  //     The BEFORE-succeeds / AFTER-rejects CONTRAST is the non-vacuity proof:
  //     it shows the LINK killed the password, not that the password never
  //     worked or rejects for an unrelated reason. If step 1 rejected too, the
  //     after-reject would prove nothing — that vacuous shape is exactly what
  //     this structure rules out.
  //
  //     ⚠️ REGRESSION-GUARD: if (3a) password is NOT null after the link, OR
  //     (3b) the old password STILL authenticates post-link → the w2bty
  //     pre-hijack takeover is REOPENED (attacker keeps a working password
  //     alongside a freshly-linked Google identity). Do NOT massage these to
  //     pass — that would hide a real account-takeover.
  // --------------------------------------------------------------------------
  it('(b) ⭐ Google link INVALIDATES the pre-existing local password (before-auth SUCCEEDS, after-auth REJECTS)', async () => {
    const auth = buildAuthWithPlatformId();
    const authService = new AuthServiceBetterAuth(testDb.db);

    const existingUserId = randomUUID();
    const email = 'prehijack-victim@example.com';
    const oldPassword = 'old-password-123';
    await authService.criarConta({
      idUsuario: existingUserId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: oldPassword,
      nome: 'Pre-Hijack Victim',
    });

    // ── STEP 1: CONTROL — BEFORE the link, the local password AUTHENTICATES.
    // iniciarSessao SUCCEEDS, returning a session token. This is the control
    // that makes the after-reject meaningful: it proves the password WORKED
    // pre-link. (iniciarSessao returns {idUsuario, token, expiraEm} on success
    // and THROWS UsuarioInputInvalidoError on bad creds — observed in
    // auth-service.better-auth.ts.)
    const sessionBefore = await authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: oldPassword,
    });
    expect(
      sessionBefore.idUsuario,
      'CONTROL: before the link the old password MUST authenticate (proves it was valid pre-link)',
    ).toBe(existingUserId);
    expect(
      sessionBefore.token,
      'CONTROL: before the link iniciarSessao must mint a session token',
    ).toBeTruthy();

    // Sanity: the credential password is a real hash before the link.
    const pwBefore = await testDb.db
      .selectFrom('accounts')
      .select('password')
      .where('user_id', '=', existingUserId)
      .where('provider_id', '=', 'credential')
      .executeTakeFirstOrThrow();
    expect(
      pwBefore.password,
      'precondition: the credential account has a non-null password before the link',
    ).toBeTruthy();

    // ── STEP 2: drive the REAL Google callback → the link fires → the
    // account.create.before hook NULLs the credential password.
    const res = await driveRealCallback(auth, {
      idTokenClaims: {
        sub: 'google-prehijack-subject-0001',
        email,
        email_verified: true,
        name: 'Google Identity',
      },
    });
    // Confirm the link actually happened (otherwise (b) would be vacuous from
    // the other direction — a no-op callback that never touched the password).
    expect([302, 303, 307]).toContain(res.status);
    const location = res.headers.get('location') ?? '';
    expect(
      location,
      'the link must SUCCEED (redirect to dashboard) so the password-NULL hook ran',
    ).toContain('dashboard');
    const linkedGoogle = await testDb.db
      .selectFrom('accounts')
      .select('id')
      .where('user_id', '=', existingUserId)
      .where('provider_id', '=', 'google')
      .execute();
    expect(linkedGoogle, 'the google account must be linked (the link fired)').toHaveLength(1);

    // ── STEP 3a: AFTER the link, the credential password IS NULL.
    const pwAfter = await testDb.db
      .selectFrom('accounts')
      .select('password')
      .where('user_id', '=', existingUserId)
      .where('provider_id', '=', 'credential')
      .executeTakeFirstOrThrow();
    expect(
      pwAfter.password,
      'aperture-qcrv4: the account.create.before hook MUST NULL the credential ' +
        'password when google links. Non-null here = the takeover is REOPENED ' +
        '(attacker keeps a working password) — a FINDING.',
    ).toBeNull();

    // ── STEP 3b: AFTER the link, the SAME old password is REJECTED.
    // iniciarSessao must throw (the NULL hash drives its no-user branch).
    await expect(
      authService.iniciarSessao({
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email,
        senha: oldPassword,
      }),
      'aperture-qcrv4 / w2bty: AFTER the link the old password MUST NOT ' +
        'authenticate. If it still mints a session, the pre-hijack takeover is ' +
        'REOPENED — a FINDING. (BEFORE-succeeds + AFTER-rejects = non-vacuous proof.)',
    ).rejects.toThrow();
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
    const [createdUser] = createdUsers;
    expect(createdUser, 'createdUsers[0] must exist after length assertion').toBeDefined();
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
    const [googleAccount] = googleAccounts;
    expect(googleAccount?.account_id, 'the google account must carry the Google sub').toBe(
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

  // --------------------------------------------------------------------------
  // (E) ALREADY-LINKED RE-LOGIN — the operator's PRIMARY-blocker regression
  //     guard (aperture-jry44, folded in from the standalone diagnostic repro).
  //
  //     SHAPE: a RETURNING user whose ONLY account is an ALREADY-LINKED google
  //     account (no local password / no credential row) signs in again with the
  //     SAME google sub. This MUST be a CLEAN sign-in — better-auth finds the
  //     existing account, updates its tokens and mints a session. It must NEVER
  //     redirect to account_not_linked.
  //
  //     The operator's prod symptom (jry44) was exactly this user getting
  //     account_not_linked on re-login. This guards that a returning
  //     already-linked Google user always signs in — regressing it back to
  //     account_not_linked (a config/better-auth/casing regression) breaks here.
  //
  //     State is seeded via raw Kysely (NOT criarConta — the operator has no
  //     password), reproducing the exact operator row shape. The ONLY thing
  //     mocked is Google's outbound token endpoint (via driveRealCallback), so
  //     the REAL callback runs its REAL account lookup + linking gate.
  // --------------------------------------------------------------------------
  it('(E) already-linked Google account re-login signs in cleanly (NOT account_not_linked)', async () => {
    const auth = buildAuthWithPlatformId();

    // The operator's exact already-linked Google sub + a no-password user.
    const googleSub = '109079365726236786089';
    const email = 'already-linked@example.com';
    const userId = randomUUID();

    // Seed the operator-shape state: a user + an EXISTING google account row,
    // NO credential row (operator has no local password).
    await testDb.db
      .insertInto('users')
      .values({
        id: userId,
        name: 'Already Linked',
        email,
        email_verified: true,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await testDb.db
      .insertInto('accounts')
      .values({
        id: randomUUID(),
        user_id: userId,
        provider_id: 'google',
        account_id: googleSub,
        password: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    // Drive the REAL callback for the SAME sub — a returning sign-in.
    const res = await driveRealCallback(auth, {
      idTokenClaims: {
        sub: googleSub,
        email,
        email_verified: true,
        name: 'Already Linked',
      },
    });

    // ── CLEAN SIGN-IN regression guard.
    const location = res.headers.get('location') ?? '';
    expect(
      location,
      'a returning user with an ALREADY-LINKED google account must NOT get ' +
        'account_not_linked — they must just sign in (the jry44/operator symptom).',
    ).not.toContain('account_not_linked');
    expect(
      setsSessionCookie(res),
      'a session cookie MUST be minted on a clean already-linked re-sign-in',
    ).toBe(true);
    expect(
      await sessionCountForUser(userId),
      'a sessions row MUST exist for the returning already-linked user',
    ).toBeGreaterThanOrEqual(1);
    expect([302, 303, 307]).toContain(res.status);
    expect(location, 'clean re-sign-in must land on the success/dashboard URL').toContain(
      'dashboard',
    );

    // Exactly ONE google accounts row for the user — no duplicate created.
    const googleAccounts = await testDb.db
      .selectFrom('accounts')
      .select('id')
      .where('user_id', '=', userId)
      .where('provider_id', '=', 'google')
      .execute();
    expect(
      googleAccounts,
      'the re-login must reuse the existing google account, never create a duplicate',
    ).toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // (F) ⭐ etdx3 SECURITY: an unverified-email Microsoft sign-in must NOT
  //     implicit-link into a pre-existing credential account (attacker lockout).
  //
  //     THREAT (nOAuth class): Microsoft multi-tenant `common` lets an attacker
  //     spin up a free Entra tenant and mint a token carrying the VICTIM's email
  //     with emailVerified=false. If `microsoft` were in trustedProviders,
  //     better-auth would implicit-link that identity into the victim's existing
  //     local account REGARDLESS of emailVerified (callback.mjs) = account
  //     takeover. The etdx3 fix keeps microsoft OUT of trustedProviders (it stays
  //     HOOK_COVERED but un-trusted), so better-auth REFUSES the link.
  //
  //     NON-VACUOUS, ORDERED ASSERTS:
  //       1. CONTROL: the victim's local password authenticates pre-attack.
  //       2. drive the REAL Microsoft callback (victim email, email_verified=false).
  //       3a. the link is REFUSED — redirect does NOT reach the dashboard and no
  //           session cookie is minted.
  //       3b. NO microsoft account row is linked to the victim's user.
  //       3c. the victim's credential password is UNCHANGED (no link → no
  //           password-NULL → the victim keeps their account).
  //       4. the victim's password STILL authenticates afterwards.
  //
  //     ⚠️ REGRESSION-GUARD: if the callback links (dashboard redirect / a
  //     microsoft account appears on the victim / a session is minted / the
  //     password is nulled) the takeover is REOPENED. Do NOT massage to pass —
  //     that would hide a real account takeover. Adding microsoft to
  //     trustedProviders is exactly what trips this.
  // --------------------------------------------------------------------------
  it('(F) ⭐ unverified-email Microsoft sign-in does NOT link to a pre-existing credential account (etdx3 takeover lockout)', async () => {
    const auth = buildAuthWithMicrosoft();
    const authService = new AuthServiceBetterAuth(testDb.db);

    const victimUserId = randomUUID();
    const email = 'etdx3-victim@example.com';
    const password = 'victim-password-123';
    await authService.criarConta({
      idUsuario: victimUserId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: password,
      nome: 'Etdx3 Victim',
    });

    // 1. CONTROL — the victim's password authenticates before the attack.
    const before = await authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: password,
    });
    expect(before.idUsuario, 'CONTROL: the victim password must authenticate pre-attack').toBe(
      victimUserId,
    );

    // 2. ATTACK — Microsoft callback spoofing the victim's email, UNVERIFIED.
    const res = await driveRealMicrosoftCallback(auth, {
      idTokenClaims: {
        sub: 'ms-attacker-subject-0001',
        email,
        email_verified: false,
        name: 'Attacker',
      },
    });

    // 3a. The link is REFUSED — no dashboard, no session.
    const location = res.headers.get('location') ?? '';
    expect(
      location,
      'attacker Microsoft sign-in must NOT reach the dashboard (link must be refused)',
    ).not.toContain('dashboard');
    expect(
      location,
      'the refuse must surface account_not_linked (the attacker is locked out)',
    ).toContain('account_not_linked');
    expect(setsSessionCookie(res), 'attacker Microsoft sign-in must NOT mint a session').toBe(
      false,
    );

    // 3b. No microsoft account linked to the victim.
    const linkedMs = await testDb.db
      .selectFrom('accounts')
      .select('id')
      .where('user_id', '=', victimUserId)
      .where('provider_id', '=', 'microsoft')
      .execute();
    expect(
      linkedMs,
      'no microsoft account may be linked to the victim (the link was refused)',
    ).toHaveLength(0);

    // 3c. The victim's credential password is UNCHANGED (link never happened).
    const pwAfter = await testDb.db
      .selectFrom('accounts')
      .select('password')
      .where('user_id', '=', victimUserId)
      .where('provider_id', '=', 'credential')
      .executeTakeFirstOrThrow();
    expect(
      pwAfter.password,
      "the victim's password must stay intact (no link → no password-NULL → victim keeps the account)",
    ).toBeTruthy();

    // 4. The victim's password STILL authenticates after the blocked attack.
    const after = await authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: password,
    });
    expect(
      after.idUsuario,
      'the victim password must still authenticate after the blocked attack',
    ).toBe(victimUserId);
  });

  // ==========================================================================
  // aperture-uq69m — Microsoft PER-REQUEST email-ownership linking.
  //
  // Microsoft stays OUT of trustedProviders ((A)+(F) unchanged). The engine's
  // mapProfileToUser predicate computes emailVerified from the id_token claims,
  // so better-auth's EXISTING gate auto-links the ownership-PROVEN cases and
  // refuses the rest. (J)/(K) prove the two link paths; (L) proves the tid
  // anchor closes the domain-spoof nOAuth vector; (M) proves the empty-name
  // fallback. The consumer tid (9188040d-…) is makeMicrosoftIdToken's default.
  // ==========================================================================
  const MS_ATTACKER_TID = '11111111-2222-3333-4444-555555555555';

  // --------------------------------------------------------------------------
  // (J) ⭐ CONSUMER MSA (hotmail) LINKS — thacyane's real prod case. An existing
  //     email+password user signs in with a genuine personal Microsoft account
  //     (consumer tid + hotmail domain). Even though the id_token carries
  //     email_verified=false (Microsoft `common` routinely omits/falses it), the
  //     engine predicate proves ownership from tid+domain → emailVerified=true →
  //     better-auth links. The HOOK_COVERED password-NULL fires (same takeover
  //     defence as Google), so the pre-existing local password is invalidated.
  // --------------------------------------------------------------------------
  it('(J) ⭐ consumer-MSA (hotmail) Microsoft sign-in LINKS to an existing account + NULLs the local password', async () => {
    const auth = buildAuthWithMicrosoft();
    const authService = new AuthServiceBetterAuth(testDb.db);

    const existingUserId = randomUUID();
    const email = 'thacyane-real@hotmail.com';
    const oldPassword = 'pre-existing-local-pw-123';
    await authService.criarConta({
      idUsuario: existingUserId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: oldPassword,
      nome: 'Thacyane Local',
    });

    // CONTROL: the local password authenticates before the link.
    const before = await authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: oldPassword,
    });
    expect(before.idUsuario, 'CONTROL: local password must authenticate pre-link').toBe(
      existingUserId,
    );

    // Consumer tid (default) + hotmail domain, email_verified deliberately FALSE
    // to prove the predicate — not the raw claim — drives the link.
    const res = await driveRealMicrosoftCallback(auth, {
      idTokenClaims: {
        sub: 'ms-consumer-subject-0001',
        email,
        email_verified: false,
        name: 'Thacyane MS',
      },
    });

    // It LINKS: session minted, microsoft account row created, dashboard redirect.
    const location = res.headers.get('location') ?? '';
    expect([302, 303, 307]).toContain(res.status);
    expect(
      location,
      'consumer-MSA hotmail must LINK (dashboard), not dead-end on account_not_linked',
    ).toContain('dashboard');
    expect(location).not.toContain('account_not_linked');
    expect(setsSessionCookie(res), 'a session cookie MUST be minted on the consumer-MSA link').toBe(
      true,
    );
    expect(await sessionCountForUser(existingUserId)).toBeGreaterThanOrEqual(1);
    const linkedMs = await testDb.db
      .selectFrom('accounts')
      .select('id')
      .where('user_id', '=', existingUserId)
      .where('provider_id', '=', 'microsoft')
      .execute();
    expect(linkedMs, 'a microsoft account row MUST be linked to the existing user').toHaveLength(1);

    // HOOK_COVERED defence: the pre-existing local password is invalidated.
    const pwAfter = await testDb.db
      .selectFrom('accounts')
      .select('password')
      .where('user_id', '=', existingUserId)
      .where('provider_id', '=', 'credential')
      .executeTakeFirstOrThrow();
    expect(
      pwAfter.password,
      'linking microsoft (HOOK_COVERED) MUST NULL the local credential password',
    ).toBeNull();
    await expect(
      authService.iniciarSessao({ idPlataforma: ID_PLATAFORMA_EUNENEM, email, senha: oldPassword }),
      'the old local password MUST NOT authenticate after the microsoft link',
    ).rejects.toThrow();
  });

  // --------------------------------------------------------------------------
  // (K) VERIFIED CUSTOM DOMAIN (xms_edov) LINKS — diego@bessa.digital's path,
  //     when the Entra app emits the optional claim. A NON-consumer tenant is
  //     fine WHEN Microsoft asserts xms_edov=true (it verifiably owns the email
  //     domain — not tenant-settable). Proves the second ownership path links.
  // --------------------------------------------------------------------------
  it('(K) xms_edov=true (Microsoft-verified custom domain) Microsoft sign-in LINKS', async () => {
    const auth = buildAuthWithMicrosoft();
    const authService = new AuthServiceBetterAuth(testDb.db);

    const existingUserId = randomUUID();
    const email = 'diego@bessa.digital';
    await authService.criarConta({
      idUsuario: existingUserId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: 'diego-local-pw-123',
      nome: 'Diego Local',
    });

    const res = await driveRealMicrosoftCallback(auth, {
      idTokenClaims: {
        sub: 'ms-edov-subject-0001',
        tid: MS_ATTACKER_TID, // a workplace tenant — trusted ONLY because xms_edov
        email,
        email_verified: false,
        xms_edov: true,
        name: 'Diego MS',
      },
    });

    const location = res.headers.get('location') ?? '';
    expect([302, 303, 307]).toContain(res.status);
    expect(location, 'xms_edov-verified email must LINK (dashboard)').toContain('dashboard');
    expect(location).not.toContain('account_not_linked');
    expect(setsSessionCookie(res)).toBe(true);
    const linkedMs = await testDb.db
      .selectFrom('accounts')
      .select('id')
      .where('user_id', '=', existingUserId)
      .where('provider_id', '=', 'microsoft')
      .execute();
    expect(linkedMs, 'a microsoft account MUST be linked on the xms_edov path').toHaveLength(1);
  });

  // --------------------------------------------------------------------------
  // (L) ⭐⭐ nOAuth LOCKOUT — external tenant SPOOFING a consumer-domain email is
  //     REFUSED. This is the security heart of the fix: an attacker owns their
  //     OWN Entra tenant, sets a user's email attribute to victim@hotmail.com,
  //     AND asserts email_verified=true. Domain-string-alone (the naive fix)
  //     would trust this and hand over the victim's account. The tid anchor
  //     (attacker tid !== consumer tid, and no xms_edov) refuses it. If this
  //     ever LINKS, the takeover is reopened — do NOT massage to pass.
  // --------------------------------------------------------------------------
  it('(L) ⭐⭐ external tenant spoofing victim@hotmail.com (attacker-asserted email_verified) is REFUSED', async () => {
    const auth = buildAuthWithMicrosoft();
    const authService = new AuthServiceBetterAuth(testDb.db);

    const victimUserId = randomUUID();
    const email = 'takeover-target@hotmail.com';
    const password = 'victim-local-pw-123';
    await authService.criarConta({
      idUsuario: victimUserId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: password,
      nome: 'Takeover Target',
    });

    const res = await driveRealMicrosoftCallback(auth, {
      idTokenClaims: {
        sub: 'ms-attacker-consumer-domain-0001',
        tid: MS_ATTACKER_TID, // attacker's OWN tenant, NOT the consumer tenant
        email, // a consumer-domain email the attacker does NOT own
        email_verified: true, // attacker asserts it — must be ignored
        name: 'Attacker',
        // NO xms_edov — the attacker's tenant does not own hotmail.com
      },
    });

    const location = res.headers.get('location') ?? '';
    expect(
      location,
      'domain-spoof from an external tenant must be REFUSED (tid anchor), never linked',
    ).toContain('account_not_linked');
    expect(location).not.toContain('dashboard');
    expect(setsSessionCookie(res), 'no session may be minted for the domain-spoof attacker').toBe(
      false,
    );
    const linkedMs = await testDb.db
      .selectFrom('accounts')
      .select('id')
      .where('user_id', '=', victimUserId)
      .where('provider_id', '=', 'microsoft')
      .execute();
    expect(linkedMs, 'no microsoft account may be linked to the victim').toHaveLength(0);
    const pwAfter = await testDb.db
      .selectFrom('accounts')
      .select('password')
      .where('user_id', '=', victimUserId)
      .where('provider_id', '=', 'credential')
      .executeTakeFirstOrThrow();
    expect(
      pwAfter.password,
      "the victim's password must stay intact (no link happened)",
    ).toBeTruthy();
    const after = await authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: password,
    });
    expect(after.idUsuario, 'the victim keeps their account after the blocked spoof').toBe(
      victimUserId,
    );
  });

  // --------------------------------------------------------------------------
  // (M) EMPTY-NAME Microsoft signup → user created with a NON-EMPTY fallback
  //     name (finding #5). Both prod victims (thacyane, diego) had users.name=''
  //     which broke the domain-heal ("Nome de exibicao nao pode ser vazio").
  //     A brand-new consumer-MSA signup with an EMPTY name claim must create a
  //     user whose name is backfilled (email local-part) so the heal can never
  //     fail on it.
  // --------------------------------------------------------------------------
  it('(M) empty-name Microsoft signup creates a user with a NON-EMPTY fallback name', async () => {
    const auth = buildAuthWithMicrosoft();

    const freshEmail = `ghost-${randomUUID()}@hotmail.com`;
    const localPart = freshEmail.split('@')[0] ?? '';

    const res = await driveRealMicrosoftCallback(auth, {
      idTokenClaims: {
        sub: `ms-emptyname-${randomUUID()}`,
        email: freshEmail,
        email_verified: false,
        name: '', // Microsoft returned an empty display name (diego/thacyane shape)
      },
    });

    // Signup succeeded (consumer MSA → emailVerified proven → clean create).
    expect([302, 303, 307]).toContain(res.status);
    const created = await testDb.db
      .selectFrom('users')
      .select(['id', 'name'])
      .where('email', '=', freshEmail)
      .executeTakeFirstOrThrow();
    expect(
      created.name,
      'the user.create.before + mapProfileToUser fallback must backfill a NON-EMPTY name',
    ).not.toBe('');
    expect(
      created.name,
      'the fallback derives the email local-part when the name claim is empty',
    ).toBe(localPart);

    // And the derived name is a valid display name (the heal will accept it).
    expect(() => NomeExibicaoUsuarioSchema.parse(created.name)).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // (G) ⭐ lwx2k / 79b31 KEYSTONE: a magic-link sign-in to a pre-existing
  //     credential account INVALIDATES the local password (attacker lockout).
  //
  //     THREAT (the keystone target): magic-link is an email-ownership-proving
  //     sign-in that authenticates an EXISTING user without an account.create
  //     event, so the OAuth password-NULL hook never fires. Attacker
  //     pre-registers victim@email via email/password (attacker knows pw);
  //     victim later signs in via magic-link → without the keystone the
  //     attacker's password STILL authenticates = takeover. The
  //     session.create.before hook NULLs the credential the instant a
  //     verified-email session is created.
  //
  //     NON-VACUOUS, ORDERED: (1) CONTROL the password authenticates pre-link;
  //     (2) run the REAL magic-link flow (signInMagicLink → consume the link);
  //     (3a) the credential password is NULL; (3b) the old password no longer
  //     authenticates. Mirror of the OAuth (b) proof for the magic-link path.
  // --------------------------------------------------------------------------
  it('(G) ⭐ magic-link sign-in NULLs a pre-existing credential password (keystone attacker lockout)', async () => {
    let capturedUrl: string | null = null;
    const auth = criarAuth(testDb.db, {
      secret: SECRET,
      baseURL: BASE_URL,
      trustedOrigins: [BASE_URL],
      sendResetPassword: async () => {
        /* no-op */
      },
      useSecureCookies: false,
      idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
      sendMagicLink: async ({ url }) => {
        capturedUrl = url;
      },
    });
    const authService = new AuthServiceBetterAuth(testDb.db);

    const victimUserId = randomUUID();
    const email = 'magiclink-victim@example.com';
    const oldPassword = 'attacker-set-password-123';
    await authService.criarConta({
      idUsuario: victimUserId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: oldPassword,
      nome: 'Magic Victim',
    });

    // 1. CONTROL — the password authenticates before the magic-link.
    const before = await authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: oldPassword,
    });
    expect(before.idUsuario, 'CONTROL: the password must authenticate before the magic-link').toBe(
      victimUserId,
    );

    // 2. Request + consume the REAL magic link (signInMagicLink fires the
    // sender → we capture the URL → drive the verify endpoint).
    await auth.api.signInMagicLink({
      body: { email, callbackURL: '/dashboard' },
      headers: new Headers({ origin: BASE_URL }),
    });
    expect(capturedUrl, 'sendMagicLink must have been invoked with a url').toBeTruthy();
    const verifyRes = await auth.handler(
      new Request(capturedUrl as unknown as string, { method: 'GET', redirect: 'manual' }),
    );
    expect([200, 302, 303, 307], 'magic-link verify must succeed (session established)').toContain(
      verifyRes.status,
    );

    // 3a. KEYSTONE — the credential password is now NULL.
    const pwAfter = await testDb.db
      .selectFrom('accounts')
      .select('password')
      .where('user_id', '=', victimUserId)
      .where('provider_id', '=', 'credential')
      .executeTakeFirstOrThrow();
    expect(
      pwAfter.password,
      'magic-link to a credential account MUST NULL the pre-existing password (keystone)',
    ).toBeNull();

    // 3b. The old password no longer authenticates — attacker locked out.
    await expect(
      authService.iniciarSessao({ idPlataforma: ID_PLATAFORMA_EUNENEM, email, senha: oldPassword }),
      'the old password MUST be rejected after the magic-link (takeover closed)',
    ).rejects.toBeDefined();
  });

  // --------------------------------------------------------------------------
  // (H) lwx2k — coexistence guard: a pure email+password user who NEVER
  //     magic-links KEEPS their password (no false-positive null). Proves the
  //     session.create.before STATE gate (email_verified=true) does not
  //     over-fire: credential rows are created email_verified=false and
  //     password login uses the engine-native session (not a better-auth
  //     verified session), so the hook never touches them.
  // --------------------------------------------------------------------------
  it('(H) pure password user keeps their password after a normal login (coexistence intact)', async () => {
    const authService = new AuthServiceBetterAuth(testDb.db);
    const userId = randomUUID();
    const email = 'pure-password@example.com';
    const password = 'legit-password-123';
    await authService.criarConta({
      idUsuario: userId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: password,
      nome: 'Pure Password',
    });

    const first = await authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: password,
    });
    expect(first.idUsuario).toBe(userId);

    const row = await testDb.db
      .selectFrom('accounts')
      .select('password')
      .where('user_id', '=', userId)
      .where('provider_id', '=', 'credential')
      .executeTakeFirstOrThrow();
    expect(
      row.password,
      'a pure-password user must KEEP their password — no false-positive null',
    ).toBeTruthy();

    // And it still authenticates on a subsequent login.
    const again = await authService.iniciarSessao({
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: password,
    });
    expect(again.idUsuario).toBe(userId);
  });

  // --------------------------------------------------------------------------
  // (I) lwx2k gate item 5 (per-EMAIL axis): the magic-link SEND is capped per
  //     email. better-auth's native limiter keys on IP+path ONLY, so the
  //     per-email cannon shield lives in the sendMagicLink chokepoint. Drive
  //     MAX+1 sends to ONE email and assert the actual delivery
  //     (config.sendMagicLink) fired exactly MAX times — the over-cap send is
  //     skipped while better-auth still returns success (no oracle). The
  //     per-IP axis is better-auth-native config (rateLimit.enabled defaults
  //     to isProduction → inert in tests by design); it is reviewed by config,
  //     not exercised here.
  // --------------------------------------------------------------------------
  it('(I) magic-link SEND is capped per email (item 5 per-email cannon shield)', async () => {
    const MAX = 5; // value-pin: must mirror MAGIC_LINK_EMAIL_MAX_SENDS in criar-auth.ts
    let sendCount = 0;
    const auth = criarAuth(testDb.db, {
      secret: SECRET,
      baseURL: BASE_URL,
      trustedOrigins: [BASE_URL],
      sendResetPassword: async () => {
        /* no-op */
      },
      useSecureCookies: false,
      idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
      sendMagicLink: async () => {
        sendCount += 1;
      },
    });

    // Deterministic target: create the user so the send path is unambiguous.
    const authService = new AuthServiceBetterAuth(testDb.db);
    const email = 'cannon-target@example.com';
    await authService.criarConta({
      idUsuario: randomUUID(),
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      senha: 'irrelevant-never-verified-123',
      nome: 'Cannon Target',
    });

    // Fire MAX+1 sends to the SAME email. better-auth returns success each time
    // (uniform, no oracle); the per-email budget skips the actual send once the
    // cap is reached within the window.
    for (let i = 0; i < MAX + 1; i += 1) {
      await auth.api.signInMagicLink({
        body: { email, callbackURL: '/dashboard' },
        headers: new Headers({ origin: BASE_URL }),
      });
    }

    expect(
      sendCount,
      `exactly ${MAX} emails should be delivered for ${MAX + 1} requests — the over-cap send is skipped`,
    ).toBe(MAX);
  });
});
