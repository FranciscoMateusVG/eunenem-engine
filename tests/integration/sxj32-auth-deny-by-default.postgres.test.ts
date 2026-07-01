import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCKED_AUTH_BODY,
  BLOCKED_AUTH_STATUS,
  installBlockedAuthHandlerGuard,
} from '../../apps/eunenem-server/server/blocked-auth-handler.js';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * SECURITY-PINNING TEST — DENY-BY-DEFAULT on the BetterAuth HTTP surface
 * (aperture-sxj32, pins aperture-9tca0 landed on EuNenem/engine #284, tip 1d92df7).
 *
 * ============================================================================
 * WHAT THIS PINS, AND WHY IT IS DIFFERENT FROM eunenem-server-auth-block.test
 * ============================================================================
 * The sibling unit test (`eunenem-server-auth-block.test.ts`) drives the guard
 * against a SENTINEL catch-all (`unblocked-sentinel`, 200). That proves the
 * guard's routing logic, but a sentinel cannot prove the POSTURE: a sentinel
 * answers 200 for *every* unmatched path, so it cannot distinguish "the guard
 * blocked it" from "the real handler would have 404'd this non-route" — the
 * exact route-recon oracle this posture is meant to close.
 *
 * This file instead wires the guard in front of the REAL `auth.handler`
 * (`criarAuth(...).handler`), in the SAME mount order as
 * `apps/eunenem-server/server.tsx`:
 *
 *     installBlockedAuthHandlerGuard(app);                    // deny-by-default
 *     app.on(['POST','GET'], '/api/auth/*', auth.handler);   // the real catch-all
 *
 * So every denied assertion below is hitting the REAL better-auth surface (the
 * one the bq2c9 casing fix activated — "a bug is not a security control"). A
 * denied route that returns 410 proves the guard short-circuits BEFORE the real
 * handler runs; the catch-all tripwire proves a regression to allow-by-default
 * would fall through to the real handler and answer with a DIFFERENT code
 * (better-auth's own 404 for an unknown route), failing the assertion loudly.
 *
 * NOTHING here is stubbed: no mock of the guard, no mock of the handler. The
 * Postgres container is real (the handler's adapter is live), so a route that
 * leaks past the guard would actually execute against the DB — the highest-
 * fidelity way to prove the escalation route is dead.
 *
 * HIGHEST-VALUE PIN: POST /api/auth/update-user with a foreign
 * {idPlataforma} body. With the 9tca0 fix this MUST 410. If it ever returns
 * 200, the cross-tenant escalation is LIVE (a P0) — do NOT massage the
 * assertion; let it fail.
 */

const SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
const BASE_URL = 'http://localhost:3001';

// A platform UUID other than the eunenem tenant — the cross-tenant escalation
// payload. If update-user ever accepts this over HTTP, an authed user moves
// tenants (aperture-9tca0 HIGH).
const OTHER_PLATFORM_ID = '00000000-0000-0000-0000-0000000000ff';

let testDb: TestDatabase;
let app: Hono;

beforeAll(async () => {
  testDb = await createTestDatabase();

  // Build the REAL engine auth — same factory server.tsx uses. We do NOT
  // reconstruct options ourselves (that would defeat the pin).
  const auth = criarAuth(testDb.db, {
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

  // Mirror server.tsx EXACTLY: deny-by-default guard, THEN the real
  // auth.handler catch-all. No sentinel — denied routes that slip past the
  // guard would hit the REAL handler (and the real DB).
  app = new Hono();
  installBlockedAuthHandlerGuard(app);
  app.on(['POST', 'GET'], '/api/auth/*', (c) => auth.handler(c.req.raw));
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

/** Drive the real app and return { status, body } for a denied-route probe. */
async function probe(
  method: 'POST' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Same as probe() but ALSO surfaces the `cache-control` header. Used by the
 * newly-allowed-route cases: the guard applies no-store on the allowed
 * passthrough (setNoStore after next() in installBlockedAuthHandlerGuard), so
 * no-store IS observable in THIS test app's scope — it is NOT a server-only
 * middleware here. `redirect: 'manual'` so a 30x is observed as a 30x, not
 * auto-followed.
 */
async function probeWithHeaders(
  method: 'POST' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string; cacheControl: string | null }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  return {
    status: res.status,
    body: await res.text(),
    cacheControl: res.headers.get('cache-control'),
  };
}

describe('DENY-BY-DEFAULT /api/auth/* on the REAL handler (aperture-sxj32 pins 9tca0)', () => {
  // --------------------------------------------------------------------------
  // 1. HIGHEST-VALUE PIN — the cross-tenant escalation route is dead.
  //    update-user with a foreign idPlataforma body MUST 410, never 200.
  // --------------------------------------------------------------------------
  describe('cross-tenant escalation (POST /api/auth/update-user) is dead', () => {
    it('POST /api/auth/update-user {idPlataforma:<other>} → 410 Gone (NOT 200 = live escalation)', async () => {
      const { status, body } = await probe('POST', '/api/auth/update-user', {
        idPlataforma: OTHER_PLATFORM_ID,
      });
      expect(
        status,
        'update-user with a foreign idPlataforma must 410. 200 here = the cross-tenant ' +
          'escalation is LIVE (aperture-9tca0 HIGH / P0). Do NOT relax this.',
      ).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
    });
  });

  // --------------------------------------------------------------------------
  // 1 (cont). DENY = uniform 410 on the saga-bypass / account-mgmt family.
  // --------------------------------------------------------------------------
  describe('saga-bypass + account-management family → uniform 410 Gone', () => {
    const DENIED_POST = [
      '/api/auth/update-user',
      '/api/auth/change-email',
      '/api/auth/delete-user',
      '/api/auth/change-password',
      '/api/auth/request-password-reset',
      '/api/auth/link-social',
      '/api/auth/unlink-account',
    ] as const;

    for (const path of DENIED_POST) {
      it(`POST ${path} → 410 Gone`, async () => {
        const { status, body } = await probe('POST', path, { probe: true });
        expect(status).toBe(BLOCKED_AUTH_STATUS);
        expect(body).toBe(BLOCKED_AUTH_BODY);
      });
    }

    it('GET /api/auth/list-accounts → 410 Gone', async () => {
      const { status, body } = await probe('GET', '/api/auth/list-accounts');
      expect(status).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
    });
  });

  // --------------------------------------------------------------------------
  // 2. CATCH-ALL TRIPWIRE — an arbitrary non-route must 410, NOT 404.
  //    If the posture ever regresses to allow-by-default (or a future
  //    better-auth route defaults open), this falls through to the REAL
  //    handler, which answers a NON-410 (its own 404 for an unknown route) —
  //    and THIS assertion fails loudly. This pins the POSTURE, not a list.
  // --------------------------------------------------------------------------
  describe('catch-all tripwire — arbitrary non-route is denied, not leaked', () => {
    it('GET /api/auth/__deny_by_default_probe__ → 410 (a 404 here = posture regressed to allow-by-default)', async () => {
      const { status, body } = await probe('GET', '/api/auth/__deny_by_default_probe__');
      expect(
        status,
        'An arbitrary /api/auth/* non-route must return the uniform 410. A 404 (or any ' +
          'non-410) means the guard let it through to the real handler = allow-by-default ' +
          'regression + a route-recon oracle.',
      ).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
    });
  });

  // --------------------------------------------------------------------------
  // 2b. ALLOWLIST-WIDENING REGRESSION PINS (aperture-a7ttv pins aperture-x3g59).
  //     Cipher widened the deny-by-default to ALSO pass GET /api/auth/error +
  //     GET /api/auth/ok (previously both 410'd, so an OAuth failure showed users
  //     a bare "Gone" instead of better-auth's readable error page). These cases
  //     pin the EXACT new allowlist shape:
  //       POSITIVE — error+ok are now reachable (NOT 410, hit the real handler).
  //       NEGATIVE — the widening did NOT crack deny-by-default: the wrong method
  //       on error, and mutative/enumeration routes, MUST still 410. The widening
  //       opened EXACTLY {GET error, GET ok} and nothing else.
  //
  //     OBSERVED against the REAL guarded handler (test-db Postgres) at pin time:
  //       GET error?error=… → 200 (HTML)   GET ok → 200 ({"ok":true})
  //       POST error → 410   POST sign-up/email → 410   GET list-sessions → 410
  //     no-store IS in scope here: the guard's setNoStore lands no-store on the
  //     allowed passthrough (NOT a server-only middleware in this test app), so
  //     the cache-control assertions below are meaningful and not faked.
  // --------------------------------------------------------------------------
  describe('allowlist widening (aperture-x3g59) — error+ok reachable, posture intact', () => {
    // POSITIVE 1 — the OAuth error page is reachable again.
    it('GET /api/auth/error?error=account_not_linked → NOT 410 (reaches better-auth error route)', async () => {
      const { status, body, cacheControl } = await probeWithHeaders(
        'GET',
        '/api/auth/error?error=account_not_linked',
      );
      expect(
        status,
        'GET /api/auth/error must NOT 410 — the x3g59 widening makes it reach the real ' +
          'better-auth error route. A 410 here = the allowlist fix is NOT effective ' +
          '(OAuth failures show a bare "Gone" again). Do NOT massage this to expect 410.',
      ).not.toBe(BLOCKED_AUTH_STATUS);
      // Pin the OBSERVED shape: in this test scope better-auth RENDERS the error
      // page (HTML 200) rather than 302-redirecting (prod, behind a baseURL, may
      // 302 → /?error=…). Accept either a redirect OR a 200, which is the
      // contract better-auth documents for this route.
      expect([200, 302, 303, 307]).toContain(status);
      if (status === 200) {
        // The error route renders an HTML page that echoes the (sanitized) code.
        expect(body).toContain('<!DOCTYPE html>');
      }
      // no-store is observable here (guard-applied on the allowed passthrough).
      expect(cacheControl).toContain('no-store');
    });

    // POSITIVE 2 — the health/ok route is reachable again.
    it('GET /api/auth/ok → 200 {"ok":true}, no-store (reaches better-auth ok route)', async () => {
      const { status, body, cacheControl } = await probeWithHeaders('GET', '/api/auth/ok');
      expect(
        status,
        'GET /api/auth/ok must NOT 410 — x3g59 widened the allowlist to pass it through ' +
          'to the real better-auth ok route. A 410 here = the fix is broken.',
      ).not.toBe(BLOCKED_AUTH_STATUS);
      expect(status).toBe(200);
      // better-auth's ok route returns the JSON health body {ok:true}.
      expect(JSON.parse(body)).toEqual({ ok: true });
      // no-store is observable here (guard-applied on the allowed passthrough).
      expect(cacheControl).toContain('no-store');
    });

    // NEGATIVE 1 — method-specificity: only GET error is allowed.
    it('POST /api/auth/error → 410 + no-store (allowlist is GET-only — no method-probing signal)', async () => {
      const { status, body, cacheControl } = await probeWithHeaders('POST', '/api/auth/error', {
        probe: true,
      });
      expect(
        status,
        'POST /api/auth/error must STILL 410 — x3g59 allowed GET only. A non-410 here = the ' +
          'widening cracked method-specificity (a method-probing signal opened up).',
      ).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
      // The guard's setNoStore runs on the DENIED branch too (aperture-0jyzj/#289),
      // so a 410 deny also carries no-store — pin it so a denied response can't be
      // cached by an intermediary. Completes the no-store coverage across BOTH guard branches.
      expect(cacheControl).toContain('no-store');
    });

    // NEGATIVE 2 — mutative write route stays dead.
    it('POST /api/auth/sign-up/email → 410 (mutative write stays denied)', async () => {
      const { status, body } = await probe('POST', '/api/auth/sign-up/email', {
        email: 'probe@example.com',
        password: 'probe-password',
        name: 'probe',
      });
      expect(
        status,
        'POST /api/auth/sign-up/email must STILL 410 — the widening must not open any ' +
          'mutative write route (sign-up runs through the tRPC saga, never HTTP).',
      ).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
    });

    // NEGATIVE 3 — enumeration route stays dead.
    it('GET /api/auth/list-sessions → 410 (enumeration stays denied)', async () => {
      const { status, body } = await probe('GET', '/api/auth/list-sessions');
      expect(
        status,
        'GET /api/auth/list-sessions must STILL 410 — the widening must not open any ' +
          'session-enumeration route.',
      ).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
    });

    // NEGATIVE 4 — catch-all tripwire still 410s (the allowlist did not open-by-default).
    // (The dedicated tripwire above already asserts this; re-pinned HERE next to the
    //  widening so a future change that over-widens to allow-by-default fails IN THIS
    //  block too, right where the widening lives.)
    it('GET /api/auth/__deny_by_default_probe__ → 410 (widening opened error+ok ONLY, not open-by-default)', async () => {
      const { status, body } = await probe('GET', '/api/auth/__deny_by_default_probe__');
      expect(
        status,
        'The catch-all tripwire must STILL 410 — the x3g59 widening must have opened ' +
          'EXACTLY {GET error, GET ok}, not relaxed the posture to allow-by-default.',
      ).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
    });
  });

  // --------------------------------------------------------------------------
  // 3. METHOD-SPECIFICITY — the allowlist is (method, path). The WRONG method
  //    on an allowed path must be denied (no method-probing signal). The
  //    CORRECT method+path stays reachable — covered by sunl9 (B)/(B2), not
  //    re-asserted here.
  // --------------------------------------------------------------------------
  describe('method-specificity — wrong method on an allowed path → 410', () => {
    it('GET /api/auth/sign-in/social → 410 (allowed only for POST)', async () => {
      const { status, body } = await probe('GET', '/api/auth/sign-in/social');
      expect(status).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
    });

    it('POST /api/auth/callback/google → 410 (allowed only for GET)', async () => {
      const { status, body } = await probe('POST', '/api/auth/callback/google', { code: 'x' });
      expect(status).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
    });
  });

  // --------------------------------------------------------------------------
  // 3b. PATH-NORMALIZATION (aperture-sxj32, Cipher probe a) — `../` must not
  //     smuggle a denied route through the callback/* allowlist. The allowlist
  //     match must resolve on the NORMALIZED path, never a raw "callback/"
  //     prefix; otherwise GET /callback/../update-user would slip update-user
  //     (the cross-tenant escalation route) past the guard to the real handler.
  // --------------------------------------------------------------------------
  describe('path-normalization — ../ cannot smuggle through the allowlist', () => {
    it('GET /api/auth/callback/../update-user → 410 (../ must not reach update-user via callback/*)', async () => {
      const { status, body } = await probe('GET', '/api/auth/callback/../update-user');
      expect(
        status,
        '../ traversal must resolve to a DENIED route (410), never match the callback/* ' +
          'allowlist and reach the real handler — a non-410 here means the guard matched a ' +
          'raw prefix and let update-user smuggle through.',
      ).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
    });
  });

  // --------------------------------------------------------------------------
  // 4. UNIFORM STATUS — every denied response is byte-identical: exactly 410
  //    with body 'Gone'. A non-uniform code (403 vs 404 vs 410) across denied
  //    routes would itself be a route-recon oracle. Collect them all and
  //    assert one set.
  // --------------------------------------------------------------------------
  describe('uniform 410 across the entire deny surface (no oracle)', () => {
    it('every denied route returns byte-identical {410, "Gone"}', async () => {
      const denied: Array<{ method: 'POST' | 'GET'; path: string; body?: unknown }> = [
        {
          method: 'POST',
          path: '/api/auth/update-user',
          body: { idPlataforma: OTHER_PLATFORM_ID },
        },
        { method: 'POST', path: '/api/auth/change-email' },
        { method: 'POST', path: '/api/auth/delete-user' },
        { method: 'POST', path: '/api/auth/change-password' },
        { method: 'POST', path: '/api/auth/request-password-reset' },
        { method: 'POST', path: '/api/auth/link-social' },
        { method: 'POST', path: '/api/auth/unlink-account' },
        { method: 'GET', path: '/api/auth/list-accounts' },
        { method: 'GET', path: '/api/auth/__deny_by_default_probe__' },
        { method: 'GET', path: '/api/auth/sign-in/social' },
        { method: 'POST', path: '/api/auth/callback/google' },
      ];

      const results = await Promise.all(
        denied.map(async (d) => {
          const { status, body } = await probe(d.method, d.path, d.body);
          return { route: `${d.method} ${d.path}`, status, body };
        }),
      );

      // Every entry must be the identical (410, 'Gone') pair.
      const distinct = new Set(results.map((r) => `${r.status}|${r.body}`));
      expect(
        distinct,
        `non-uniform deny responses = route-recon oracle. Observed: ${JSON.stringify(results)}`,
      ).toEqual(new Set([`${BLOCKED_AUTH_STATUS}|${BLOCKED_AUTH_BODY}`]));
    });
  });
});
