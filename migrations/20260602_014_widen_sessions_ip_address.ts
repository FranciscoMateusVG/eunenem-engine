import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Widen `sessions.ip_address` from `varchar(45)` to `varchar(128)`.
 *
 * Discovered 2026-06-02 during operator's end-to-end flow walkthrough:
 * `auth.signIn` returned a 500 with `value too long for type character
 * varying(45)`. Root cause: aperture-3pqt7 / T9 wired BetterAuth to hash
 * the client IP via `hashClientPII` before persisting to
 * `sessions.ip_address` for privacy (the comment on the column intent is
 * recorded in `apps/eunenem-server/server/auth/setup.ts:114`).
 * `hashClientPII` returns SHA256 hex (64 chars), but the BetterAuth
 * default schema at migration 009 declared the column as `varchar(45)`
 * — sized for a raw IPv6 max (`ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff`),
 * not a hash. Production posture (operator) — every signIn / signUp
 * with a non-empty `LOG_PII_HASH_SALT` overflows; dev only escapes
 * because the j0ccg (aperture-j0ccg) fallback returns the shorter
 * `unhashed:<value>` marker when salt is empty.
 *
 * Why 128 not 64:
 *   - SHA256 hex is exactly 64 chars — would work as the minimum
 *   - varchar(128) gives forward headroom for SHA512 hex (128) or any
 *     future longer marker (e.g. `${algo}:<hex>` namespacing for hash
 *     rotation, which a follow-up will likely want).
 *   - The fallback `unhashed:<IPv6>` is ≤ 54 chars, well inside 128.
 *   - Storage cost difference is rounding error at this volume.
 *
 * No data backfill needed — existing rows under varchar(45) are
 * dimensionally compatible with the widened column. Postgres ALTER
 * COLUMN to a strictly-larger varchar is metadata-only on Postgres ≥9.2
 * (no table rewrite), so this migration is fast even on populated tables.
 *
 * Down-migration narrows back to varchar(45) for forward-compat with the
 * pre-3pqt7 schema, but would truncate any existing >45-char values
 * (the very rows we're widening to support). In practice, the down path
 * is only safe immediately after up — once any hashed sessions exist,
 * `down` would lose data. Documented inline; do not run blindly.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sessions
      ALTER COLUMN ip_address TYPE varchar(128)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // WARNING: narrowing back to varchar(45) will FAIL on any row whose
  // ip_address exceeds 45 chars (i.e. the hashed rows this up-migration
  // exists to support). Do not run unless the sessions table is empty
  // OR an explicit data-cleanup step precedes this.
  await sql`
    ALTER TABLE sessions
      ALTER COLUMN ip_address TYPE varchar(45)
  `.execute(db);
}
