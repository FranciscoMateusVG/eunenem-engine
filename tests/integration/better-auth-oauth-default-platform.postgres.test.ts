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
 * This drives BetterAuth's internal create path via the real magic-link
 * request + verify flow — the SAME internalAdapter.createUser + databaseHooks
 * path the OAuth callback uses. With idPlataforma input:false (aperture-9tca0)
 * the caller can't override it, so a successful create with the right
 * id_plataforma proves the hook injected it from the SERVER CONSTANT — never
 * from request input.
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

  async function consumeMagicLink(
    auth: ReturnType<typeof criarAuth>,
    capturedUrl: string | null,
  ): Promise<void> {
    expect(capturedUrl, 'sendMagicLink must receive the verification URL').toBeTruthy();
    const verifyResponse = await auth.handler(
      new Request(capturedUrl as string, { method: 'GET', redirect: 'manual' }),
    );
    expect([200, 302, 303, 307]).toContain(verifyResponse.status);
  }

  it('creates the user with id_plataforma = the server constant (not from input)', async () => {
    await truncateBetterAuthTables(testDb.db);
    let capturedUrl: string | null = null;
    const auth = criarAuth(testDb.db, {
      secret: 'test-secret-at-least-thirty-two-characters-long',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3001'],
      idPlataformaPadrao: TEST_PLATFORM,
      socialProviders: { google: { clientId: 'x', clientSecret: 'y' } },
      sendMagicLink: async ({ url }) => {
        capturedUrl = url;
      },
    });

    await auth.api.signInMagicLink({
      body: { email: 'newoauth@example.com', callbackURL: '/dashboard' },
      headers: new Headers({ origin: 'http://localhost:3001' }),
    });
    await consumeMagicLink(auth, capturedUrl);

    const row = (await testDb.db
      .selectFrom('users' as never)
      .select(['id_plataforma' as never])
      .where('email' as never, '=', 'newoauth@example.com' as never)
      .executeTakeFirst()) as { id_plataforma: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.id_plataforma).toBe(TEST_PLATFORM);
  });

  it('never accepts a request-supplied idPlataforma (no cross-tenant smuggle)', async () => {
    await truncateBetterAuthTables(testDb.db);
    let capturedUrl: string | null = null;
    const auth = criarAuth(testDb.db, {
      secret: 'test-secret-at-least-thirty-two-characters-long',
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:3001'],
      idPlataformaPadrao: TEST_PLATFORM,
      sendMagicLink: async ({ url }) => {
        capturedUrl = url;
      },
    });

    // Attacker-style: try to smuggle a different tenant via the public
    // magic-link request. The plugin's strict body schema strips the unknown
    // property; consuming the link proves the server hook still owns the
    // persisted tenant assignment.
    await auth.api.signInMagicLink({
      body: {
        email: 'attacker@example.com',
        callbackURL: '/dashboard',
        idPlataforma: '99999999-9999-9999-9999-999999999999',
      } as never,
      headers: new Headers({ origin: 'http://localhost:3001' }),
    });
    await consumeMagicLink(auth, capturedUrl);

    const smuggled = (await testDb.db
      .selectFrom('users' as never)
      .select(['id_plataforma' as never])
      .where('id_plataforma' as never, '=', '99999999-9999-9999-9999-999999999999' as never)
      .executeTakeFirst()) as { id_plataforma: string } | undefined;
    expect(smuggled).toBeUndefined();

    const local = (await testDb.db
      .selectFrom('users' as never)
      .select(['id_plataforma' as never])
      .where('email' as never, '=', 'attacker@example.com' as never)
      .executeTakeFirstOrThrow()) as { id_plataforma: string };
    expect(local.id_plataforma).toBe(TEST_PLATFORM);
  });
});
