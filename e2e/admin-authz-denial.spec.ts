/**
 * aperture-98w0s — admin authorization boundary DENIAL gate (e2e).
 *
 * The eunenem `/admin` surface spans ALL tenants and includes the money-moving
 * `admin.repasses.aprovar` mutation. The server-side boundary is the
 * `adminMiddleware` in apps/eunenem-server/server/trpc/admin-router.ts, applied
 * to EVERY procedure via `adminProcedure`:
 *
 *   1. AUTHENTICATION — no valid session  → UNAUTHORIZED (401)
 *   2. AUTHORIZATION  — authed email not in the ADMIN_ALLOWED_EMAILS allowlist
 *                       → FORBIDDEN (403); empty allowlist fails closed.
 *
 * That gate is UNIT-tested (tests/unit/server/admin-gate.test.ts via
 * createCaller with stubbed deps), but NOTHING drove a REAL authed
 * NON-allowlisted user over HTTP against a live server and asserted FORBIDDEN.
 * This spec closes that gap end-to-end against the actual tRPC HTTP handler
 * (`/api/trpc/*`, server.tsx).
 *
 * Representative procedures (both share the identical `adminMiddleware`, so
 * gating them proves the boundary for the whole `admin.*` surface):
 *   - `admin.searchUsers`      — a representative bulk-PII READ query (also the
 *                                proc the unit test exercises).
 *   - `admin.repasses.aprovar` — the MONEY-MOVING mutation. tRPC runs
 *                                middleware BEFORE input parsing, so the gate
 *                                fires even on a dummy payload — proving the
 *                                cash path is closed to non-admins.
 *
 * Arms:
 *   1. authed NON-allowlisted user  → FORBIDDEN on the read query
 *   2. authed NON-allowlisted user  → FORBIDDEN on the money mutation
 *   3. anonymous (no session)       → UNAUTHORIZED (the distinct 401 branch)
 *   4. NEGATIVE CONTROL — the allowlisted admin fixture CAN call the SAME read
 *      query → success. Proves the gate is allowlist-BASED, not blanket-broken
 *      (i.e. the FORBIDDEN in arms 1-2 means "this caller", not "everyone").
 *   5. FRONTEND — a non-admin browser hitting `/admin/*` is bounced to `/` by
 *      the AdminShell UX gate (aperture-r5fg0). This is UX-only; the backend
 *      arms above are the real boundary.
 *
 * The non-admin is `seededData`'s campaign owner: a genuine authed user whose
 * email (`e2e-test-*@e2e.local`) is NOT the allowlisted admin fixture email
 * (`e2e-admin@e2e.local`, pinned into ADMIN_ALLOWED_EMAILS in
 * playwright.config.ts). Same allowlist, different email → the exact
 * "authed-but-not-admin" case unit tests can only simulate with stubs.
 */
import type { APIRequestContext } from '@playwright/test';
import { request as pwRequest } from '@playwright/test';
import { expect, test } from './fixtures.js';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

/** Representative admin READ query (bulk PII). Non-blank prefix = a real query
 *  attempt, so a bypassed gate would actually execute against the DB. */
const ADMIN_READ = 'admin.searchUsers';
/** Representative money-moving admin mutation. */
const ADMIN_MONEY_MUTATION = 'admin.repasses.aprovar';

interface TrpcOutcome {
  ok: boolean;
  status: number;
  /** tRPC error code (e.g. FORBIDDEN / UNAUTHORIZED), from error.data.code. */
  code?: string;
  message?: string;
  data?: unknown;
}

/** GET a tRPC query and return the raw outcome WITHOUT asserting — the caller
 *  decides. No transformer is registered on this app (router.ts), so `input`
 *  is the raw JSON and the wire shape is plain `{result|error}`. */
async function trpcQuery(
  api: APIRequestContext,
  procedure: string,
  input?: unknown,
): Promise<TrpcOutcome> {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await api.get(`${BASE_URL}/api/trpc/${procedure}${qs}`);
  const body = (await res.json().catch(() => ({}))) as {
    result?: { data?: unknown };
    error?: { message?: string; data?: { code?: string } };
  };
  return {
    ok: res.ok(),
    status: res.status(),
    code: body.error?.data?.code,
    message: body.error?.message,
    data: body.result?.data,
  };
}

/** POST a tRPC mutation and return the raw outcome. tRPC runs middleware
 *  BEFORE input validation, so the admin gate rejects before the payload is
 *  ever parsed — a dummy input suffices to prove the mutation is gated. */
async function trpcMutation(
  api: APIRequestContext,
  procedure: string,
  input: unknown,
): Promise<TrpcOutcome> {
  const res = await api.post(`${BASE_URL}/api/trpc/${procedure}`, { data: input });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; data?: { code?: string } };
  };
  return {
    ok: res.ok(),
    status: res.status(),
    code: body.error?.data?.code,
    message: body.error?.message,
  };
}

test.describe('admin authz boundary — denial (aperture-98w0s)', () => {
  test('(1) authed NON-allowlisted user → FORBIDDEN on admin read query', async ({
    authenticatedContext,
    seededData,
  }) => {
    // `authenticatedContext` carries seededData's real BetterAuth session cookie
    // — a genuine authed user, but NOT the allowlisted admin email.
    expect(
      seededData.email,
      'guard: the non-admin MUST NOT be the allowlisted admin email',
    ).not.toBe('e2e-admin@e2e.local');

    const out = await trpcQuery(authenticatedContext.request, ADMIN_READ, { prefix: 'a' });

    // CRITICAL: a 2xx here means a non-admin READ the admin surface — P0 leak.
    expect(
      out.ok,
      `SECURITY: non-admin got ${out.status} on ${ADMIN_READ} (expected 403 FORBIDDEN). ` +
        `data=${JSON.stringify(out.data)}`,
    ).toBe(false);
    expect(out.status).toBe(403);
    expect(out.code).toBe('FORBIDDEN');
  });

  test('(2) authed NON-allowlisted user → FORBIDDEN on money-moving mutation', async ({
    authenticatedContext,
  }) => {
    // Dummy payload: the gate fires before input parsing, so no repasse is
    // ever touched. This proves admin.repasses.aprovar (the cash path) is
    // closed to non-admins — the highest-stakes proc on the surface.
    const out = await trpcMutation(authenticatedContext.request, ADMIN_MONEY_MUTATION, {
      idRepasse: '00000000-0000-4000-8000-000000000000',
      bankTransferRef: 'e2e-should-never-apply',
    });

    expect(
      out.ok,
      `SECURITY: non-admin got ${out.status} on ${ADMIN_MONEY_MUTATION} (expected 403 FORBIDDEN).`,
    ).toBe(false);
    expect(out.status).toBe(403);
    expect(out.code).toBe('FORBIDDEN');
  });

  test('(3) anonymous (no session) → UNAUTHORIZED [CONTROL for the 401 branch]', async () => {
    // Fresh cookie-less request context — no session at all.
    const anon = await pwRequest.newContext();
    try {
      const out = await trpcQuery(anon, ADMIN_READ, { prefix: 'a' });
      expect(
        out.ok,
        `SECURITY: anonymous caller got ${out.status} on ${ADMIN_READ} (expected 401 UNAUTHORIZED).`,
      ).toBe(false);
      expect(out.status).toBe(401);
      expect(out.code).toBe('UNAUTHORIZED');
    } finally {
      await anon.dispose();
    }
  });

  test('(4) NEGATIVE CONTROL — allowlisted admin CAN call the same read query', async ({
    adminAuthenticatedContext,
  }) => {
    // Same procedure, same server, allowlisted session. prefix '' short-circuits
    // to [] AFTER the gate → success here proves the gate is allowlist-BASED
    // (not blanket-broken), so the FORBIDDEN in arms 1-2 means "this caller".
    const out = await trpcQuery(adminAuthenticatedContext.request, ADMIN_READ, { prefix: '' });

    expect(
      out.ok,
      `allowlisted admin was denied ${ADMIN_READ}: ${out.status} code=${out.code}. ` +
        `The allowlist gate may be broken CLOSED for everyone.`,
    ).toBe(true);
    expect(out.status).toBe(200);
    expect(Array.isArray(out.data)).toBe(true);
  });

  test('(5) FRONTEND — non-admin browser at /admin bounces to landing "/"', async ({
    authenticatedPage: page,
    seededData,
  }) => {
    // AdminShell (aperture-r5fg0) reads auth.me.isAdmin; a non-admin (incl.
    // logged-out) is `window.location.assign('/')`-bounced and the shell never
    // renders. UX-only guard — the backend arms above are the real boundary.
    await page.goto(`${BASE_URL}/admin/campanha/${seededData.idCampanha}`);
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe('/');
  });
});
