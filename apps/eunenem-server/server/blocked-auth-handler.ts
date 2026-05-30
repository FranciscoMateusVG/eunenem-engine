import type { Hono } from 'hono';

/**
 * BetterAuth HTTP auth-flow paths that the engine deliberately keeps
 * unreachable on the eunenem-server (aperture-ln3de).
 *
 * Cipher's pre-prod review (aperture-ebspa) identified two findings
 * that one fix collapses:
 *
 *   C1 (CRITICAL, reproduced live): POST /api/auth/sign-in/email
 *      returns HTTP 500 for KNOWN emails and HTTP 401 for UNKNOWN —
 *      a deterministic user-enumeration oracle. Root cause:
 *      BetterAuth's HTTP signIn looks up accounts by
 *      `accounts.account_id == email`, but the engine saga writes
 *      `account_id == idPlataforma::email` (composite). The lookup
 *      hits an unhandled error path AFTER finding the user row,
 *      which 500s instead of returning the generic
 *      `INVALID_EMAIL_OR_PASSWORD` 401. An attacker can enumerate
 *      every registered customer in O(N) HTTP requests.
 *
 *   H1 (HIGH): the full `auth.handler` mount at `/api/auth/*` is a
 *      latent saga-bypass surface. `/api/auth/sign-up/email`
 *      currently fails with `FAILED_TO_CREATE_USER` 422, but is one
 *      config tweak (BetterAuth version bump, an `additionalFields`
 *      relaxation) away from succeeding and creating users that
 *      bypass the engine saga entirely — no `plataforma`
 *      validation, no domain `Usuario` aggregate, no `slug`, no
 *      `PERMISSOES_PADRAO`, no `Conta`. Latent bypass = security
 *      problem today, not when it becomes active.
 *
 * The engine's policy: every authn flow runs through tRPC at
 * `/api/trpc/auth.*` so the saga executes end-to-end (plataforma
 * validation, domain row, compensation on partial failure). The
 * BetterAuth HTTP endpoints below are blocked with byte-identical
 * 410 Gone responses so neither status code, body, nor latency
 * exposes any signal about whether an email is registered.
 *
 * `forget-password` is included until the SMTP transport bead lands —
 * today `sendResetPassword` (setup.ts) is a console.log stub, so a
 * user requesting reset would have the link only appear in the
 * server log. Confused-deputy UX bug if we leave it on.
 *
 * NOT blocked here (intentional): `/api/auth/verify-email` and
 * `/api/auth/callback/*`. These are BetterAuth-internal flows that
 * need to remain reachable so future bead can opt them in. If a
 * future bead adds a new HTTP-side flow we don't want exposed, it
 * MUST add the path here.
 *
 * Both GET and POST are blocked on each path (via `app.all`) so
 * method-based probing (`GET` vs `POST`) cannot distinguish a
 * blocked endpoint from one that simply rejects the method.
 */
export const BLOCKED_AUTH_PATHS = [
  '/api/auth/sign-up/email',
  '/api/auth/sign-in/email',
  '/api/auth/sign-out',
  '/api/auth/forget-password',
] as const;

/** Byte-identical response body returned for every blocked path. */
export const BLOCKED_AUTH_BODY = 'Gone';

/** Status code returned for every blocked path. */
export const BLOCKED_AUTH_STATUS = 410 as const;

/**
 * Install the block guard on a Hono app. MUST be called BEFORE the
 * `auth.handler` catch-all mount on `/api/auth/*` so the specific
 * paths win the route match regardless of router implementation.
 *
 * Idempotent in practice: registering the same path twice is a no-op
 * for the wire behavior, though it would leak into Hono's internal
 * route table.
 */
export function installBlockedAuthHandlerGuard(app: Hono): void {
  for (const path of BLOCKED_AUTH_PATHS) {
    app.all(path, (c) => {
      c.status(BLOCKED_AUTH_STATUS);
      return c.text(BLOCKED_AUTH_BODY);
    });
  }
}
