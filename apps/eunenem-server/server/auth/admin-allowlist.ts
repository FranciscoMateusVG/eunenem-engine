/**
 * Admin email allowlist (aperture-4n222).
 *
 * The eunenem `/admin` surface — the entire tRPC `admin.*` router, incl. the
 * money-moving `admin.repasses.aprovar` mutation — is gated to a small set of
 * operator emails. The source is the `ADMIN_ALLOWED_EMAILS` env var
 * (comma-separated), parsed ONCE at boot into a normalized Set carried on
 * `ServerDeps`. Both enforcement points read that SAME set:
 *
 *   - the server-side `adminProcedure` gate in admin-router.ts (THE security
 *     boundary — returns 403 for a non-allowlisted authenticated user), and
 *   - the `auth.me` `isAdmin` flag the frontend pins to for its UX gate.
 *
 * Reading one constant keeps enforcement and the UI signal from drifting.
 *
 * NORMALIZATION: trim + lowercase on BOTH the configured entries and the
 * compared email, so `"Franciscomateusvg@Gmail.com "` matches the seed
 * `franciscomateusvg@gmail.com`. Blank entries are dropped.
 *
 * FAIL-CLOSED: an unset / empty env yields an EMPTY allowlist → nobody is admin
 * → every admin route 403s. That is the safe failure mode for a security gate:
 * a misconfiguration locks the admin area down rather than opening it up.
 */

/** Parse the comma-separated `ADMIN_ALLOWED_EMAILS` env into a normalized Set. */
export function parseAdminAllowedEmails(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * True iff `email` is in the allowlist (normalized compare). Used by BOTH the
 * server-side gate and the `auth.me` `isAdmin` flag so the two never diverge.
 */
export function isEmailAdmin(allowed: ReadonlySet<string>, email: string): boolean {
  return allowed.has(email.trim().toLowerCase());
}
