import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarAuth } from '../../src/adapters/usuario/criar-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';

/**
 * aperture-dm7s3 — a brand-new OAuth user has no idPlataforma in their profile,
 * and users.id_plataforma is notNull. The user.create.before databaseHook
 * injects the server-side platform constant so adapter-driven user creation
 * (OAuth signup) succeeds with the correct tenant.
 *
 * This drives BetterAuth's internal create path via auth.api.signUpEmail — the
 * SAME internalAdapter.createUser + databaseHooks path the OAuth callback uses
 * (and it bypasses the HTTP deny-by-default guard, which is Hono-layer only).
 * With idPlataforma input:false (aperture-9tca0) the caller can't supply it, so
 * a successful create with the right id_plataforma proves the hook injected it
 * from the SERVER CONSTANT — never from request input.
 */
describe('OAuth/adapter user-create injects the server platform id (aperture-dm7s3)', () => {
  let testDb: TestDatabase;
  const TEST_PLATFORM = '11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    testDb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  it('creates the user with id_plataforma = the server constant (not from input)', async () => {
    await truncateBetterAuthTables(testDb.db);
    const auth = criarAuth(testDb.db, {
      secret: 'test-secret-at-least-thirty-two-characters-long',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3001'],
      sendResetPassword: async () => {},
      idPlataformaPadrao: TEST_PLATFORM,
      socialProviders: { google: { clientId: 'x', clientSecret: 'y' } },
    });

    await auth.api.signUpEmail({
      body: { email: 'newoauth@example.com', password: 'BogusBogus123!', name: 'New OAuth User' },
    });

    const row = (await testDb.db
      .selectFrom('users' as never)
      .select(['id_plataforma' as never])
      .where('email' as never, '=', 'newoauth@example.com' as never)
      .executeTakeFirst()) as { id_plataforma: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.id_plataforma).toBe(TEST_PLATFORM);
  });

  it('rejects a request-supplied idPlataforma (no cross-tenant smuggle via signup)', async () => {
    await truncateBetterAuthTables(testDb.db);
    const auth = criarAuth(testDb.db, {
      secret: 'test-secret-at-least-thirty-two-characters-long',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3001'],
      sendResetPassword: async () => {},
      idPlataformaPadrao: TEST_PLATFORM,
    });

    // Attacker-style: try to smuggle a different tenant via the signup body.
    // idPlataforma input:false (aperture-9tca0) rejects it outright — the create
    // is REFUSED, so no user with the smuggled tenant is ever written. This is
    // the signup-path mirror of the update-user escalation, closed the same way.
    await expect(
      auth.api.signUpEmail({
        body: {
          email: 'attacker@example.com',
          password: 'BogusBogus123!',
          name: 'Attacker',
          idPlataforma: '99999999-9999-9999-9999-999999999999',
        } as never,
      }),
    ).rejects.toThrow();

    const smuggled = (await testDb.db
      .selectFrom('users' as never)
      .select(['id_plataforma' as never])
      .where('id_plataforma' as never, '=', '99999999-9999-9999-9999-999999999999' as never)
      .executeTakeFirst()) as { id_plataforma: string } | undefined;
    expect(smuggled).toBeUndefined();
  });
});
