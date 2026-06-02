import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashClientPII } from '../../src/observability/hash-client-pii.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * Regression pin for aperture-vcen4.
 *
 * THE BUG: BetterAuth migration 009 declared `sessions.ip_address` as
 * `varchar(45)` — sized for raw IPv6 max — but aperture-3pqt7 wired
 * BetterAuth to hash the client IP via `hashClientPII` (SHA256 hex, 64
 * chars) before persisting. Production deploys with `LOG_PII_HASH_SALT`
 * set overflowed on every signIn / signUp with:
 *     `value too long for type character varying(45)`
 *
 * THE FIX: migration 014 widened to `varchar(128)`, giving headroom for
 * SHA256 (64), SHA512 (128), the dev j0ccg fallback `unhashed:<value>`
 * (≤54 chars), AND future algo-prefixed shapes like `sha512:<hex>`.
 *
 * THIS TEST: a tight regression pin. It (a) asserts the column type via
 * information_schema, AND (b) replays the actual INSERT shape from
 * `auth-service.better-auth.ts:226-249` with every value flavor
 * `hashClientPII` can produce, asserting each one fits without throwing.
 * If anyone re-narrows the column or removes the widen migration, every
 * assertion here fires.
 *
 * Salt-aware (per aperture-vcen4 follow-up ask (d)): exercises BOTH the
 * production posture (real salt → SHA256 hex) AND the dev fallback
 * (empty salt + NODE_ENV=development → `unhashed:<value>` marker, per
 * aperture-j0ccg). Plus a synthetic SHA512-shaped 128-char hex for the
 * forward-compat algo-upgrade case, plus the rejection upper bound at
 * 129 chars so we know the column boundary is real.
 */

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe('sessions.ip_address column shape (aperture-vcen4 regression pin)', () => {
  let savedNodeEnv: string | undefined;

  beforeEach(async () => {
    // Clean every row that might FK-cascade or pre-occupy the table.
    // Order matters: sessions → accounts → users (FK references).
    await testDb.db.deleteFrom('sessions').execute();
    await testDb.db.deleteFrom('accounts').execute();
    await testDb.db.deleteFrom('users').execute();
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  /** Seed a `users` row so the FK on `sessions.user_id` is satisfied. */
  const seedUser = async (): Promise<string> => {
    const userId = randomUUID();
    await testDb.db
      .insertInto('users')
      .values({
        id: userId,
        id_plataforma: randomUUID(),
        email: `user-${userId}@test.local`,
        email_verified: false,
        name: 'Test User',
      })
      .execute();
    return userId;
  };

  /**
   * Replays the EXACT INSERT shape from auth-service.better-auth.ts's
   * `iniciarSessao` (lines 226-249) — same columns, same value sources
   * for non-IP fields. Only `ip_address` varies across tests.
   */
  const insertSessionWithIp = (userId: string, ipAddress: string | null) =>
    testDb.db
      .insertInto('sessions')
      .values({
        id: randomUUID(),
        user_id: userId,
        token: `tok_${randomUUID()}`,
        expires_at: new Date(Date.now() + 3600_000),
        ip_address: ipAddress,
        user_agent: null,
      })
      .execute();

  it('column type is varchar(128) — narrowing would re-introduce the vcen4 500', async () => {
    const row = (await testDb.db
      // biome-ignore lint/suspicious/noExplicitAny: information_schema isn't in db-types.generated
      .selectFrom('information_schema.columns' as any)
      // biome-ignore lint/suspicious/noExplicitAny: same
      .select(['data_type' as any, 'character_maximum_length' as any])
      // biome-ignore lint/suspicious/noExplicitAny: same
      .where('table_schema' as any, '=', 'public' as any)
      // biome-ignore lint/suspicious/noExplicitAny: same
      .where('table_name' as any, '=', 'sessions' as any)
      // biome-ignore lint/suspicious/noExplicitAny: same
      .where('column_name' as any, '=', 'ip_address' as any)
      .executeTakeFirst()) as { data_type: string; character_maximum_length: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.data_type).toBe('character varying');
    expect(row?.character_maximum_length).toBe(128);
  });

  it('accepts SHA256 hashed IP (the production posture path with LOG_PII_HASH_SALT set)', async () => {
    const userId = await seedUser();
    const realSalt = 'prod-grade-salt-thirty-two-chars-aaaaaaaaaaaaaa';
    const hashed = hashClientPII('203.0.113.45', realSalt);
    expect(hashed).toHaveLength(64); // SHA256 hex
    await expect(insertSessionWithIp(userId, hashed)).resolves.not.toThrow();
  });

  it('accepts SHA256 hashed IPv6 max — same hash length regardless of input length', async () => {
    const userId = await seedUser();
    const realSalt = 'prod-grade-salt-thirty-two-chars-aaaaaaaaaaaaaa';
    const ipv6Max = 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff';
    const hashed = hashClientPII(ipv6Max, realSalt);
    expect(hashed).toHaveLength(64);
    await expect(insertSessionWithIp(userId, hashed)).resolves.not.toThrow();
  });

  it('accepts the dev-fallback unhashed:<IPv4> marker (j0ccg path, salt empty)', async () => {
    process.env.NODE_ENV = 'development';
    const userId = await seedUser();
    const fallback = hashClientPII('203.0.113.45', '');
    expect(fallback).toBe('unhashed:203.0.113.45');
    await expect(insertSessionWithIp(userId, fallback)).resolves.not.toThrow();
  });

  it('accepts the dev-fallback unhashed:<IPv6 max> marker (j0ccg path, longest realistic dev value)', async () => {
    process.env.NODE_ENV = 'development';
    const userId = await seedUser();
    const ipv6Max = 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff';
    const fallback = hashClientPII(ipv6Max, '');
    expect(fallback).toBe(`unhashed:${ipv6Max}`);
    // 9 chars 'unhashed:' + 39 chars IPv6 max = 48. Well inside 128.
    expect(fallback.length).toBe(48);
    await expect(insertSessionWithIp(userId, fallback)).resolves.not.toThrow();
  });

  it('accepts a SHA512-shaped 128-char hex (forward-compat for algo-upgrade ceiling)', async () => {
    const userId = await seedUser();
    const sha512Like = 'a'.repeat(128);
    await expect(insertSessionWithIp(userId, sha512Like)).resolves.not.toThrow();
  });

  it('accepts null when ipHashed is empty/absent (auth-service-better-auth shape — empty hash → null)', async () => {
    const userId = await seedUser();
    await expect(insertSessionWithIp(userId, null)).resolves.not.toThrow();
  });

  it('rejects values exceeding varchar(128) — the column boundary IS real', async () => {
    const userId = await seedUser();
    const tooLong = 'x'.repeat(129);
    await expect(insertSessionWithIp(userId, tooLong)).rejects.toThrow(
      /value too long for type character varying\(128\)/,
    );
  });

  it('round-trip: persisted hash reads back byte-identical (no truncation/encoding loss)', async () => {
    const userId = await seedUser();
    const hashed = hashClientPII(
      '203.0.113.45',
      'prod-grade-salt-thirty-two-chars-aaaaaaaaaaaaaa',
    );
    await insertSessionWithIp(userId, hashed);
    const row = await testDb.db
      .selectFrom('sessions')
      .select('ip_address')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.ip_address).toBe(hashed);
    expect(row.ip_address).toHaveLength(64);
  });
});
