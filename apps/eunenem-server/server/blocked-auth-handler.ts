import type { Hono } from 'hono';

/**
 * DENY-BY-DEFAULT guard on the BetterAuth HTTP surface (`/api/auth/*`).
 *
 * aperture-9tca0 supersedes the original aperture-ln3de denylist. History:
 * ln3de blocked 4 specific paths (sign-up/email, sign-in/email, sign-out,
 * forget-password) — ALLOW-BY-DEFAULT. That posture was only safe because a
 * latent better-auth adapter casing bug (aperture-bq2c9) 500'd EVERY adapter
 * query, so the rest of the BetterAuth HTTP surface was accidentally inert.
 * The bq2c9 fix activates the adapter, so every route under the catch-all
 * mount (`app.on([POST,GET], '/api/auth/*', auth.handler)`) is now functional.
 * "A bug is not a security control" — Cipher's adapter-activation sweep found:
 *
 *   - CROSS-TENANT ESCALATION (HIGH): POST /api/auth/update-user accepts
 *     arbitrary fields; idPlataforma was writable via HTTP input → any
 *     authenticated user could move tenants, bypassing the engine saga.
 *   - The ln3de denylist named `/api/auth/forget-password`, which does NOT
 *     exist in better-auth@1.6.12 — the real `/api/auth/request-password-reset`
 *     was left UNBLOCKED.
 *   - /change-email, /delete-user, /change-password, /link-social,
 *     /unlink-account, /list-accounts, /account-info — all saga-bypass /
 *     unreviewed surfaces, newly functional.
 *
 * The engine policy: every authn flow runs through tRPC at `/api/trpc/auth.*`
 * so the saga executes end-to-end (plataforma validation, domain Usuario
 * aggregate, slug, PERMISSOES_PADRAO, Conta, compensation on partial failure).
 * The ONLY BetterAuth HTTP routes the engine deliberately exposes are the
 * Google OAuth init + provider callback. EVERYTHING else under /api/auth/* is
 * denied with a byte-identical 410 Gone (no status/body/latency signal that
 * could distinguish a blocked route or enumerate registered emails).
 *
 * Adding a new exposed flow REQUIRES adding it to the allowlist below AND a
 * Cipher review — the deny-by-default posture means new better-auth routes are
 * inert until explicitly allowed, which is the safe failure mode.
 */

/**
 * The allowlist: the exact (method, path) pairs permitted to reach
 * `auth.handler`. METHOD-SPECIFIC on purpose — only the two requests the
 * Google OAuth flow actually issues are allowed; every other method on these
 * same paths (e.g. GET /sign-in/social, POST /callback/*) is denied with the
 * uniform 410, so there is no method-probing signal.
 *
 *   - POST /api/auth/sign-in/social     — OAuth init (returns provider redirect)
 *   - GET  /api/auth/callback/<provider> — OAuth provider callback (the FAMILY,
 *     so a new provider needs no guard change). Google uses the GET (query)
 *     callback; a provider that needs POST form_post would require adding it
 *     here + a Cipher review (deny-by-default = safe failure mode).
 */
export function isAllowedAuthRequest(method: string, path: string): boolean {
  if (method === 'POST' && path === '/api/auth/sign-in/social') return true;
  if (method === 'GET' && path.startsWith('/api/auth/callback/')) return true;
  return false;
}

/** Byte-identical response body returned for every blocked path. */
export const BLOCKED_AUTH_BODY = 'Gone';

/** Status code returned for every blocked path. */
export const BLOCKED_AUTH_STATUS = 410 as const;

/**
 * Install the deny-by-default guard on a Hono app. MUST be called BEFORE the
 * `auth.handler` catch-all mount on `/api/auth/*` so the guard wins the route
 * match and runs first. Allowed paths fall through via `next()` to the
 * catch-all; everything else short-circuits with a byte-identical 410.
 */
export function installBlockedAuthHandlerGuard(app: Hono): void {
  app.all('/api/auth/*', async (c, next) => {
    if (isAllowedAuthRequest(c.req.method, c.req.path)) {
      await next();
      return;
    }
    c.status(BLOCKED_AUTH_STATUS);
    return c.text(BLOCKED_AUTH_BODY);
  });
}
