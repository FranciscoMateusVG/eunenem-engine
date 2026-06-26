import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  BLOCKED_AUTH_BODY,
  BLOCKED_AUTH_STATUS,
  installBlockedAuthHandlerGuard,
  isAllowedAuthRequest,
} from '../../apps/eunenem-server/server/blocked-auth-handler.js';

/**
 * Regression tests for the BetterAuth HTTP deny-by-default guard.
 *
 * aperture-9tca0 (supersedes the aperture-ln3de denylist): the bq2c9 adapter
 * casing fix made the whole BetterAuth HTTP surface functional, so the old
 * allow-by-default-with-4-denials posture was unsafe (cross-tenant escalation
 * via /api/auth/update-user, saga-bypass routes, a stale block name). The guard
 * is now DENY-BY-DEFAULT: only the OAuth allowlist (sign-in/social + callback/*)
 * reaches auth.handler; everything else returns a byte-identical 410 Gone.
 *
 * These tests exist so a future re-mount, router change, or middleware reorder
 * cannot reopen the surface — and so the escalation route specifically stays
 * dead.
 */
function buildAppWithGuard(): Hono {
  const app = new Hono();
  installBlockedAuthHandlerGuard(app);
  // Sentinel catch-all that mirrors server.tsx's auth.handler mount.
  // Any NON-allowlisted path that reaches this handler is a regression.
  app.on(['POST', 'GET'], '/api/auth/*', (c) => c.text('unblocked-sentinel', 200));
  return app;
}

// The routes that MUST be denied. Includes the HIGH cross-tenant escalation
// (update-user), the saga-bypass family, the account-linking management
// surface, and the original ln3de four (now blocked by default).
const MUST_BLOCK_PATHS = [
  '/api/auth/update-user', // HIGH: idPlataforma cross-tenant escalation
  '/api/auth/change-email',
  '/api/auth/delete-user',
  '/api/auth/change-password',
  '/api/auth/request-password-reset', // the real route (ln3de named a stale 'forget-password')
  '/api/auth/forget-password', // stale name — still denied by default
  '/api/auth/link-social',
  '/api/auth/unlink-account',
  '/api/auth/list-accounts',
  '/api/auth/account-info',
  '/api/auth/sign-up/email',
  '/api/auth/sign-in/email',
  '/api/auth/sign-out',
  '/api/auth/verify-email', // not needed for Google OAuth → denied by default
] as const;

// The only paths permitted through to auth.handler.
const MUST_ALLOW = [
  { method: 'POST', path: '/api/auth/sign-in/social' },
  { method: 'GET', path: '/api/auth/callback/google' },
  { method: 'GET', path: '/api/auth/callback/oauth' },
  // aperture-3c9na: the frontend BetterAuth client's own-session READ endpoint.
  // Own-cookie-scoped (no IDOR / no enumeration / no cross-tenant); GET only.
  { method: 'GET', path: '/api/auth/get-session' },
] as const;

describe('eunenem-server deny-by-default auth guard (aperture-9tca0)', () => {
  describe('denied (deny-by-default) → 410 Gone, never reaches the catch-all', () => {
    for (const path of MUST_BLOCK_PATHS) {
      for (const method of ['POST', 'GET'] as const) {
        it(`${method} ${path} → ${BLOCKED_AUTH_STATUS} ${BLOCKED_AUTH_BODY}`, async () => {
          const app = buildAppWithGuard();
          const res = await app.request(path, {
            method,
            headers: { 'content-type': 'application/json' },
            body:
              method === 'POST'
                ? JSON.stringify({ idPlataforma: '00000000-0000-0000-0000-0000000000ff' })
                : undefined,
          });
          expect(res.status).toBe(BLOCKED_AUTH_STATUS);
          expect(await res.text()).toBe(BLOCKED_AUTH_BODY);
          // aperture-0jyzj: 410 is cacheable-by-default → must carry no-store so
          // the browser/client never serves a stale deny after the allowlist changes.
          expect(res.headers.get('cache-control')).toContain('no-store');
        });
      }
    }
  });

  describe('cross-tenant escalation route is dead (the 9tca0 HIGH)', () => {
    it('POST /api/auth/update-user with idPlataforma override → 410, never reaches handler', async () => {
      const app = buildAppWithGuard();
      const res = await app.request('/api/auth/update-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idPlataforma: 'victim-tenant-uuid' }),
      });
      const body = await res.text();
      expect(res.status).toBe(BLOCKED_AUTH_STATUS);
      expect(body).toBe(BLOCKED_AUTH_BODY);
      expect(body).not.toBe('unblocked-sentinel');
    });
  });

  describe('OAuth allowlist still reaches the catch-all', () => {
    for (const { method, path } of MUST_ALLOW) {
      it(`${method} ${path} → sentinel 200 (allowed through)`, async () => {
        const app = buildAppWithGuard();
        const res = await app.request(`${path}?code=abc&state=xyz`, { method });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('unblocked-sentinel');
        // aperture-0jyzj: allowed auth responses (incl. get-session 200) must
        // also be no-store — a cached get-session is a stale auth state.
        expect(res.headers.get('cache-control')).toContain('no-store');
      });
    }
  });

  describe('enumeration oracle stays closed on /api/auth/sign-in/email', () => {
    it('byte-identical 410 for KNOWN-shaped vs UNKNOWN-shaped emails', async () => {
      const app = buildAppWithGuard();
      const knownLike = await app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'franciscomateusvg@gmail.com', password: 'BogusBogus123' }),
      });
      const unknownLike = await app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'never-was@test.local', password: 'BogusBogus123' }),
      });
      expect(knownLike.status).toBe(BLOCKED_AUTH_STATUS);
      expect(unknownLike.status).toBe(BLOCKED_AUTH_STATUS);
      const [knownBody, unknownBody] = await Promise.all([knownLike.text(), unknownLike.text()]);
      expect(knownBody).toBe(unknownBody);
    });
  });

  describe('arbitrary deny-by-default probe → uniform 410 (no route-recon oracle)', () => {
    it('GET /api/auth/__deny_by_default_probe__ → 410 (same as explicit denials)', async () => {
      const app = buildAppWithGuard();
      const res = await app.request('/api/auth/__deny_by_default_probe__', { method: 'GET' });
      expect(res.status).toBe(BLOCKED_AUTH_STATUS);
      expect(await res.text()).toBe(BLOCKED_AUTH_BODY);
    });
  });

  describe('allowlist predicate shape (method-specific)', () => {
    it('allows exactly POST sign-in/social + GET callback/*', () => {
      expect(isAllowedAuthRequest('POST', '/api/auth/sign-in/social')).toBe(true);
      expect(isAllowedAuthRequest('GET', '/api/auth/callback/google')).toBe(true);
      expect(isAllowedAuthRequest('GET', '/api/auth/callback/apple')).toBe(true);
      // aperture-3c9na: the frontend session-READ endpoint, GET only.
      expect(isAllowedAuthRequest('GET', '/api/auth/get-session')).toBe(true);
      // wrong METHOD on an allowed path is denied (no method-probing signal)
      expect(isAllowedAuthRequest('GET', '/api/auth/sign-in/social')).toBe(false);
      expect(isAllowedAuthRequest('POST', '/api/auth/callback/google')).toBe(false);
      // get-session is a READ — POST (the mutating shape) stays denied
      expect(isAllowedAuthRequest('POST', '/api/auth/get-session')).toBe(false);
      // wrong PATH is denied — the mutation/oracle routes STAY denied (no
      // blanket relaxation; get-session is the ONLY route 3c9na exempts)
      expect(isAllowedAuthRequest('POST', '/api/auth/update-user')).toBe(false);
      expect(isAllowedAuthRequest('POST', '/api/auth/change-email')).toBe(false);
      expect(isAllowedAuthRequest('POST', '/api/auth/request-password-reset')).toBe(false);
      expect(isAllowedAuthRequest('GET', '/api/auth/list-sessions')).toBe(false);
      expect(isAllowedAuthRequest('POST', '/api/auth/sign-in/email')).toBe(false);
      expect(isAllowedAuthRequest('GET', '/api/auth/verify-email')).toBe(false);
      // not a prefix-confusion: 'callback' without trailing slash, social-evil
      expect(isAllowedAuthRequest('GET', '/api/auth/callback')).toBe(false);
      expect(isAllowedAuthRequest('POST', '/api/auth/sign-in/social-evil')).toBe(false);
    });
  });
});
