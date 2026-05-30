import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  BLOCKED_AUTH_BODY,
  BLOCKED_AUTH_PATHS,
  BLOCKED_AUTH_STATUS,
  installBlockedAuthHandlerGuard,
} from '../../apps/eunenem-server/server/blocked-auth-handler.js';

/**
 * Regression tests for the BetterAuth HTTP block guard (aperture-ln3de).
 *
 * Cipher's pre-prod review (aperture-ebspa) found:
 *   - C1: /api/auth/sign-in/email returns 500 for known emails,
 *         401 for unknown → user-enumeration oracle
 *   - H1: full auth.handler mount is a latent saga-bypass surface
 *
 * The fix installs a guard that returns byte-identical 410 Gone
 * responses on the four affected HTTP paths BEFORE the auth.handler
 * catch-all on /api/auth/*. These tests exist so a future re-mount,
 * router change, or middleware reorder cannot reopen the surface.
 */
function buildAppWithGuard(): Hono {
  const app = new Hono();
  installBlockedAuthHandlerGuard(app);
  // Sentinel catch-all that mirrors server.tsx's auth.handler mount.
  // Any blocked path that ever reaches this handler is a regression.
  app.on(['POST', 'GET'], '/api/auth/*', (c) => c.text('unblocked-sentinel', 200));
  return app;
}

describe('eunenem-server blocked-auth-handler guard (aperture-ln3de)', () => {
  describe('blocked paths', () => {
    for (const path of BLOCKED_AUTH_PATHS) {
      for (const method of ['POST', 'GET'] as const) {
        it(`${method} ${path} → ${BLOCKED_AUTH_STATUS} ${BLOCKED_AUTH_BODY}`, async () => {
          const app = buildAppWithGuard();
          const res = await app.request(path, {
            method,
            headers: { 'content-type': 'application/json' },
            body:
              method === 'POST'
                ? JSON.stringify({ email: 'probe@example.com', password: 'BogusBogus123' })
                : undefined,
          });
          expect(res.status).toBe(BLOCKED_AUTH_STATUS);
          expect(await res.text()).toBe(BLOCKED_AUTH_BODY);
        });
      }
    }
  });

  describe('enumeration oracle closed on /api/auth/sign-in/email (C1)', () => {
    it('returns byte-identical responses for KNOWN-shaped vs UNKNOWN-shaped emails', async () => {
      const app = buildAppWithGuard();

      // Known-shaped: an address that, against a live DB, would have
      // existed (operator's email per Cipher's reproduction). The
      // guard short-circuits before any DB lookup, so the request
      // never touches storage — the test is hermetic.
      const knownLike = await app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'franciscomateusvg@gmail.com', password: 'BogusBogus123' }),
      });
      // Unknown-shaped: an address guaranteed to be absent.
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

  describe('unblocked /api/auth/* paths still reach the catch-all', () => {
    it('GET /api/auth/verify-email → sentinel 200 (not blocked)', async () => {
      const app = buildAppWithGuard();
      const res = await app.request('/api/auth/verify-email?token=xyz', { method: 'GET' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('unblocked-sentinel');
    });

    it('GET /api/auth/callback/oauth → sentinel 200 (not blocked)', async () => {
      const app = buildAppWithGuard();
      const res = await app.request('/api/auth/callback/oauth?code=abc', { method: 'GET' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('unblocked-sentinel');
    });
  });

  describe('block list shape', () => {
    it('blocks exactly the four BetterAuth HTTP authn endpoints', () => {
      expect([...BLOCKED_AUTH_PATHS]).toStrictEqual([
        '/api/auth/sign-up/email',
        '/api/auth/sign-in/email',
        '/api/auth/sign-out',
        '/api/auth/forget-password',
      ]);
    });
  });
});
