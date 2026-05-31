import { TRPCError } from '@trpc/server';
import { sql } from 'kysely';
import type { Database } from '../../../../src/index.js';

/**
 * DB-backed sliding-window rate limiter (aperture-uc2ix).
 *
 * Backed by the `rate_limit` table from migration 009 — the same table
 * BetterAuth uses for its /api/auth/* throttling, keeping rate-limit
 * storage centralized (multi-instance safe, survives container restart).
 *
 * **Algorithm (fixed window with last-request gate):** for each (key,
 * window) bucket, atomically increment a counter and read the prior
 * value. If `now - last_request > windowMs`, RESET count to 1 (the
 * current request counts as the first attempt in a fresh window).
 * Otherwise increment count; if count > max, reject.
 *
 * Reset semantics use `last_request` per row (not a wall-clock window
 * boundary), which is technically a "rolling reset" rather than a fixed
 * window — slightly more permissive at the boundary than BetterAuth's
 * default, but symmetric and predictable. The trade-off is acceptable
 * for visitor-facing auth flows; tighten via separate beads if a
 * specific abuse pattern emerges.
 *
 * **Atomic upsert:** uses `INSERT ... ON CONFLICT (key) DO UPDATE`
 * with a CASE expression so the increment + reset decision happen in a
 * single SQL statement — no read-then-write race between two parallel
 * requests for the same bucket.
 *
 * **Why postgres-only:** the engine ships only the Postgres adapter for
 * production. If a future deploy targets a different DB, mirror this
 * helper for that dialect; the rate-limit contract is provider-agnostic.
 */
export interface RateLimitOptions {
  readonly key: string;
  readonly max: number;
  readonly windowMs: number;
  readonly clock?: () => Date;
}

export interface RateLimitResult {
  /** True if the request is within the limit and may proceed. */
  readonly allowed: boolean;
  /** Current count after the increment (or after the reset). */
  readonly count: number;
  /** Window cap (echoed for caller convenience). */
  readonly max: number;
  /** Window duration (ms; echoed for caller convenience). */
  readonly windowMs: number;
}

/**
 * Check + atomically increment the rate-limit counter for `key`. Returns
 * `{ allowed, count, max, windowMs }`. Caller decides what to do on
 * `!allowed` — usually throw a TRPCError TOO_MANY_REQUESTS.
 *
 * Key naming convention: `"<surface>:<bucket>"` — e.g.
 * `"trpc:signIn:<ipHash>:<emailHash>"`, `"trpc:signUp:<ipHash>"`. Keep
 * each key ≤255 chars (rate_limit.key is varchar(255) per migration 009).
 */
export async function consumeRateLimit(
  db: Database,
  { key, max, windowMs, clock = () => new Date() }: RateLimitOptions,
): Promise<RateLimitResult> {
  if (key.length === 0 || key.length > 255) {
    throw new Error(
      `rate-limit key must be 1-255 chars (varchar(255)); got ${key.length}: "${key.slice(0, 80)}..."`,
    );
  }

  const now = clock().getTime();
  const windowStart = now - windowMs;

  // Atomic upsert + read. PostgreSQL's `RETURNING` exposes the row state
  // AFTER the upsert ran, so we get the post-increment count + decision
  // in one round-trip.
  //
  //   - If no existing row: INSERT with count=1, last_request=now
  //   - If existing row and last_request < windowStart: reset count to 1,
  //     bump last_request to now
  //   - Else: increment count, bump last_request to now
  //
  // The CASE in the SET expression encodes the reset-vs-increment branch.
  // biome-ignore lint/suspicious/noExplicitAny: Kysely<unknown> + raw SQL
  const result = await sql<{ count: number }>`
    INSERT INTO rate_limit (id, key, count, last_request)
    VALUES (${cryptoRandomId()}, ${key}, 1, ${now})
    ON CONFLICT (key) DO UPDATE
    SET
      count = CASE
        WHEN rate_limit.last_request < ${windowStart} THEN 1
        ELSE rate_limit.count + 1
      END,
      last_request = ${now}
    RETURNING count
  `.execute(db as never);

  const row = result.rows[0];
  if (!row) {
    // Should never happen — INSERT ... ON CONFLICT always returns a row.
    throw new Error(`rate-limit upsert returned no row for key="${key}"`);
  }

  return {
    allowed: row.count <= max,
    count: row.count,
    max,
    windowMs,
  };
}

/**
 * Wraps `consumeRateLimit` and throws TOO_MANY_REQUESTS if the bucket
 * is full. Convenience for tRPC procedures.
 */
export async function enforceRateLimit(
  db: Database,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const result = await consumeRateLimit(db, opts);
  if (!result.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      // Generic message — never leak the bucket key or remaining-attempts
      // count (would help an attacker calibrate their pacing).
      message: 'Muitas tentativas. Aguarde alguns instantes e tente novamente.',
    });
  }
  return result;
}

/**
 * UUID-v4 generator for the rate_limit.id primary key. We could collide
 * the id space with BetterAuth's (it uses the same `id` PK) — varchar(36)
 * is wide enough, and UUIDs don't collide in practice.
 */
function cryptoRandomId(): string {
  // randomUUID is available in Node 19+; engine requires Node 20+.
  return globalThis.crypto.randomUUID();
}
