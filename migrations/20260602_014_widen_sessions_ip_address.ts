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
 * pre-3pqt7 schema. After aperture-vcen4 follow-up, the down path
 * carries an explicit pre-flight guard: it counts existing rows with
 * `ip_address` > 45 chars and throws an actionable error BEFORE invoking
 * the ALTER, instead of relying on Postgres's terse `value too long for
 * type character varying(45)`. Operators who actually need to narrow
 * back must first clear or migrate those rows.
 *
 * Why not rename to `ip_address_hash`?
 *   Considered (aperture-vcen4 follow-up review). The name `ip_address`
 *   is the BetterAuth upstream convention — renaming would diverge from
 *   the BetterAuth plugin schema, break kysely-codegen alignment with
 *   future BetterAuth upgrades, and require a sweep of every reader. The
 *   value being a hash is a runtime decision (see the comment at
 *   `auth-service.better-auth.ts:233-243`); the column name documents
 *   the conceptual identity, the code documents the encoding. Not worth
 *   the upstream-divergence cost for a documentation win.
 *
 * Why varchar(128) not text?
 *   Considered (aperture-vcen4 follow-up review). Postgres treats
 *   varchar(N) and text identically at the storage layer — the only
 *   difference is varchar(N)'s length check. For a column that should
 *   hold opaque ≤128-char identifiers, the bound is documentation +
 *   defense-in-depth (catches an upstream bug that tries to write 10MB
 *   before the row reaches durable storage). text would be more
 *   future-proof but less defensive. varchar(128) wins on the explicit-
 *   intent axis.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE sessions
      ALTER COLUMN ip_address TYPE varchar(128)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Pre-flight guard (aperture-vcen4 follow-up): refuse to narrow if
  // any existing row would be truncated. Postgres's own error
  // (`value too long for type character varying(45)`) is correct but
  // unactionable — this guard makes the failure mode explicit and
  // tells the operator exactly what to do. Cheap single-row query;
  // runs once per migration invocation.
  const longRows = await sql<{ n: string }>`
    SELECT COUNT(*)::text AS n FROM sessions WHERE LENGTH(ip_address) > 45
  `.execute(db);
  const longCount = Number(longRows.rows[0]?.n ?? '0');
  if (longCount > 0) {
    throw new Error(
      `Cannot narrow sessions.ip_address to varchar(45): ${longCount} row(s) ` +
        `have values >45 chars (the hashed-PII rows this column widen exists to ` +
        `support). Delete or migrate those rows first, then re-run migrateDown.`,
    );
  }
  await sql`
    ALTER TABLE sessions
      ALTER COLUMN ip_address TYPE varchar(45)
  `.execute(db);
}
