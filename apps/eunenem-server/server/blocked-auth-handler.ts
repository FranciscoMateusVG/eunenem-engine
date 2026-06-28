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
 *   - GET  /api/auth/get-session        — the frontend BetterAuth client's
 *     session-READ endpoint (client.js calls it to learn whether the user is
 *     logged in). aperture-3c9na: the original 9tca0 allowlist over-reached —
 *     it omitted get-session because the BACKEND resolver uses the PROGRAMMATIC
 *     `auth.api.getSession`, but the FRONTEND client uses this HTTP route, so
 *     blocking it made the client conclude "logged-out" even with a valid
 *     session (the visible 6wo1f symptom). SAFE to allow (Cipher-verified vs
 *     better-auth@1.6.12 session.mjs): it resolves the session ONLY from the
 *     requester's own SIGNED cookie (`getSignedCookie(...sessionToken, secret)`)
 *     — no session-id/token query param (no IDOR), returns the requester's own
 *     {session,user} or null (cookie-keyed, not email-keyed → no enumeration;
 *     own-tenant only → no cross-tenant leak). It is a READ of one's OWN session.
 *     Only GET is allowed (the method the client issues); the mutation/oracle
 *     routes (update-user, change-email, request-password-reset, etc.) STAY
 *     denied — this is a single-route exemption, NOT a blanket relaxation.
 */
export function isAllowedAuthRequest(method: string, path: string): boolean {
  if (method === 'POST' && path === '/api/auth/sign-in/social') return true;
  if (method === 'GET' && path.startsWith('/api/auth/callback/')) return true;
  if (method === 'GET' && path === '/api/auth/get-session') return true;
  // aperture-x3g59: the deny-by-default over-reached on the OAuth ERROR page —
  // it 410'd GET /api/auth/error, so every OAuth failure showed users a bare
  // "Gone" instead of better-auth's readable error (in prod a 302 → /?error=...).
  // Same over-reach class as the 3c9na get-session miss: a display-only route
  // got swept up in the deny-by-default. Cipher-verified vs better-auth@1.6.12
  // (api/routes/error.mjs + ok.mjs):
  //   - GET /api/auth/error — reads ?error/?error_description, REGEX-whitelists
  //     the code (/^['A-Za-z0-9_-]+$/) + HTML-escapes the description
  //     (sanitize()), then renders HTML or 302-redirects. NO state mutation, no
  //     DB write, no session/cookie, no secret — it only echoes back a sanitized
  //     error code. XSS-safe.
  //   - GET /api/auth/ok — returns {ok:true}; a stateless health check the
  //     better-auth client pings. No state, no secret.
  // Both are standard public better-auth display/health routes — allowlisting
  // them is NOT a recon oracle (their existence is documented/open-source, and
  // they leak nothing user-specific). The mutation/data/enumeration routes
  // (update-user, change-email, request-password-reset, list-sessions, …) STAY
  // denied. GET-only on purpose — no method-probing signal. no-store still
  // applies (these are auth responses). Single-route exemptions, NOT a blanket
  // relaxation; a new exposed route still requires a Cipher review.
  if (method === 'GET' && path === '/api/auth/error') return true;
  if (method === 'GET' && path === '/api/auth/ok') return true;
  // aperture-lwx2k (Camada C) — the passwordless magic-link flow. Two routes,
  // method-specific (every other method on them stays denied = no probing
  // signal). Cipher-gated exposure (review against aperture-79b31):
  //   - POST /api/auth/sign-in/magic-link — the SEND. Issues a single-use,
  //     hashed-at-rest, 5-min token and emails the link. Response is uniform
  //     ("if you have an account, we sent a link") with no account-existence
  //     oracle. ⚠️ abuse surface (email-bombing / send-cost) → gate item 5
  //     (DONE, aperture-lwx2k): DB-backed rate-limit on BOTH axes, wired in
  //     criar-auth.ts — per-IP via better-auth's native rateLimit.customRules
  //     ('/sign-in/magic-link', DB storage, keyed IP+path) and per-EMAIL via a
  //     send-budget counter in the sendMagicLink chokepoint (better-auth can't
  //     key on email). Both reuse the rate_limit table (migration 009) — no
  //     Redis. Over-cap sends are skipped, preserving the uniform response.
  //   - GET /api/auth/magic-link/verify — the CONSUME. Validates+consumes the
  //     token atomically (single-use, GHSA-hc7v-rggr-4hvx), establishes the
  //     session, and 302s to callbackURL. better-auth's originCheck middleware
  //     validates callbackURL/newUserCallbackURL/errorCallbackURL against
  //     trustedOrigins (open-redirect gate, item 4). The session.create.before
  //     keystone NULLs any pre-existing credential password (takeover gate).
  // The mutation/data/enumeration routes (update-user, change-email,
  // request-password-reset, list-sessions, …) STAY denied. no-store still
  // applies. A new exposed route still requires a Cipher review.
  if (method === 'POST' && path === '/api/auth/sign-in/magic-link') return true;
  if (method === 'GET' && path === '/api/auth/magic-link/verify') return true;
  return false;
}

/** Byte-identical response body returned for every blocked path. */
export const BLOCKED_AUTH_BODY = 'Gone';

/** Status code returned for every blocked path. */
export const BLOCKED_AUTH_STATUS = 410 as const;

/**
 * No-cache headers applied to EVERY /api/auth/* response (aperture-0jyzj).
 * Auth/session responses must NEVER be cached: a 410 is cacheable-by-default
 * per RFC 7234, so the browser AND the BetterAuth client's fetch cached the
 * pre-3c9na 410 from GET /api/auth/get-session and served it STALE — the client
 * concluded "logged-out" from a cached deny even after the allowlist fix
 * deployed. no-store on both the allowed passthrough (get-session 200, callback,
 * sign-in/social) AND the 410 deny responses prevents any browser/intermediary
 * cache from serving a stale auth/session state.
 */
function setNoStore(c: { header: (name: string, value: string) => void }): void {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
}

/**
 * Install the deny-by-default guard on a Hono app. MUST be called BEFORE the
 * `auth.handler` catch-all mount on `/api/auth/*` so the guard wins the route
 * match and runs first. Allowed paths fall through via `next()` to the
 * catch-all; everything else short-circuits with a byte-identical 410. Every
 * response (allowed or denied) carries no-store (aperture-0jyzj).
 */
export function installBlockedAuthHandlerGuard(app: Hono): void {
  app.all('/api/auth/*', async (c, next) => {
    if (isAllowedAuthRequest(c.req.method, c.req.path)) {
      await next();
      setNoStore(c);
      return;
    }
    setNoStore(c);
    c.status(BLOCKED_AUTH_STATUS);
    return c.text(BLOCKED_AUTH_BODY);
  });
}
