import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';

/**
 * aperture-bq2c9 — regression guard for the better-auth adapter casing bug.
 *
 * better-auth@1.6.12 does NOT apply `database.casing:'snake'` to COLUMN names
 * in its kysely adapter (only table names; verified in @better-auth/core
 * get-tables.mjs). The snake_case columns from migration 009 are mapped ONLY
 * by the explicit per-field `fields` maps in criar-auth.ts. Before that fix the
 * adapter emitted camelCase columns (accounts.accountId, verifications.expiresAt)
 * → Postgres 42703 → 500 on the entire Google OAuth flow.
 *
 * The app's email+password path BYPASSES the adapter (raw Kysely in
 * AuthServiceBetterAuth), so this only surfaced once OAuth — the first adapter
 * consumer — was driven. This test exercises the adapter DIRECTLY (the exact
 * layer that 42703'd) against a real migrated Postgres, covering every mapped
 * table: users, accounts, verifications.
 */
describe('better-auth adapter — snake_case column mapping (aperture-bq2c9)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  function buildAuth() {
    return criarAuth(testDb.db, {
      secret: 'test-secret-at-least-thirty-two-characters-long',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3001'],
      sendResetPassword: async () => {
        /* no-op for this adapter-layer test */
      },
      socialProviders: {
        google: { clientId: 'test-client-id', clientSecret: 'test-client-secret' },
      },
    });
  }

  it('round-trips user → account → verification through the adapter without 42703', async () => {
    await truncateBetterAuthTables(testDb.db);
    const auth = buildAuth();
    // better-auth exposes the resolved auth context (incl. the internal adapter)
    // via `$context`. This is the same adapter the OAuth callback drives.
    const ctx = await (auth as unknown as { $context: Promise<{ adapter: Adapter }> }).$context;
    const adapter = ctx.adapter;

    // USERS — exercises emailVerified→email_verified, createdAt/updatedAt, and
    // the additionalField idPlataforma→id_plataforma (latent until OAuth signup).
    const user = await adapter.create({
      model: 'user',
      data: {
        name: 'Casing Probe',
        email: 'casing-probe@example.com',
        emailVerified: true,
        idPlataforma: '00000000-0000-0000-0000-000000000001',
      },
    });
    expect(user.id).toBeTruthy();

    // ACCOUNTS — the bead-title bug: findOAuthUser queries accounts.accountId.
    // Exercises accountId→account_id, providerId→provider_id, userId→user_id, etc.
    const account = await adapter.create({
      model: 'account',
      data: {
        userId: user.id,
        providerId: 'google',
        accountId: 'google-subject-12345',
        accessToken: 'tok_access',
        refreshToken: 'tok_refresh',
        idToken: 'tok_id',
        scope: 'openid email profile',
      },
    });
    expect(account.id).toBeTruthy();

    // The exact query findOAuthUser runs — by accountId (→ account_id column).
    const foundByAccountId = await adapter.findOne({
      model: 'account',
      where: [{ field: 'accountId', value: 'google-subject-12345' }],
    });
    expect(foundByAccountId).not.toBeNull();
    expect((foundByAccountId as { userId: string }).userId).toBe(user.id);

    // VERIFICATIONS — createVerificationValue (the first 500 on sign-in/social
    // init) writes expiresAt → expires_at.
    const verification = await adapter.create({
      model: 'verification',
      data: {
        identifier: 'state:probe',
        value: 'verification-payload',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(verification.id).toBeTruthy();

    const foundVerification = await adapter.findOne({
      model: 'verification',
      where: [{ field: 'identifier', value: 'state:probe' }],
    });
    expect(foundVerification).not.toBeNull();
    expect((foundVerification as { value: string }).value).toBe('verification-payload');
  });
});

/** Minimal structural type for the better-auth internal adapter surface used here. */
interface Adapter {
  create: (args: { model: string; data: Record<string, unknown> }) => Promise<{ id: string }>;
  findOne: (args: {
    model: string;
    where: Array<{ field: string; value: unknown }>;
  }) => Promise<Record<string, unknown> | null>;
}
