import { createHmac, randomUUID } from 'node:crypto';
import type { DBAdapter } from 'better-auth/types';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildServerDeps,
  loadEnv,
  type ServerDeps,
} from '../../apps/eunenem-server/server/auth/setup.js';
import { installBlockedAuthHandlerGuard } from '../../apps/eunenem-server/server/blocked-auth-handler.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { resolverUsuarioAutenticadoOuNull } from '../../apps/eunenem-server/server/trpc/session-resolver.js';
import { criarAuth, ID_PLATAFORMA_EUCASEI, ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateBetterAuthTables } from '../helpers/truncate-better-auth.js';

const SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
const BASE_URL = 'http://localhost:3001';
const SUCCESS_CALLBACK_URL = `${BASE_URL}/dashboard`;
const ERROR_CALLBACK_URL = `${BASE_URL}/oauth-error`;
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MICROSOFT_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_GRAPH = 'https://graph.microsoft.com/';
const MICROSOFT_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';

type Provider = 'google' | 'microsoft';

let testDb: TestDatabase;
let deps: ServerDeps;
let authApp: Hono;

beforeAll(async () => {
  testDb = await createTestDatabase();
  deps = buildServerDeps(
    loadEnv({
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: BASE_URL,
      TRUSTED_ORIGINS: BASE_URL,
      ADMIN_ALLOWED_EMAILS: 'tenant-boundary-admin@test.local',
      DATABASE_URL: testDb.connectionUri,
      NODE_ENV: 'test',
      LEGACY_SITE_ORIGIN: 'https://eunenem.com',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      MICROSOFT_CLIENT_ID: 'test-microsoft-client-id',
      MICROSOFT_CLIENT_SECRET: 'test-microsoft-client-secret',
      MICROSOFT_TENANT_ID: 'common',
    }),
  );

  authApp = new Hono();
  installBlockedAuthHandlerGuard(authApp);
  authApp.on(['POST', 'GET'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw));
}, 60_000);

afterAll(async () => {
  await deps.db.destroy();
  await testDb.teardown();
});

beforeEach(async () => {
  await truncateBetterAuthTables(testDb.db);
});

function signStateCookie(value: string): string {
  const signature = createHmac('sha256', SECRET).update(value).digest('base64');
  return encodeURIComponent(`${value}.${signature}`);
}

function makeIdToken(provider: Provider, claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const audience = provider === 'google' ? 'test-google-client-id' : 'test-microsoft-client-id';
  const issuer =
    provider === 'google'
      ? 'https://accounts.google.com'
      : 'https://login.microsoftonline.com/common/v2.0';
  return `${encode({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })}.${encode({
    iss: issuer,
    aud: audience,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })}.sig`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installProviderFetchMock(provider: Provider, claims: Record<string, unknown>): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (
      (provider === 'google' && url.startsWith(GOOGLE_TOKEN_ENDPOINT)) ||
      (provider === 'microsoft' && url.startsWith(MICROSOFT_TOKEN_ENDPOINT))
    ) {
      return new Response(
        JSON.stringify({
          access_token: `${provider}-access-after`,
          refresh_token: `${provider}-refresh-after`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: provider === 'google' ? 'email profile openid' : 'openid profile email User.Read',
          id_token: makeIdToken(provider, claims),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (provider === 'microsoft' && url.startsWith(MICROSOFT_GRAPH)) {
      return new Response(null, { status: 404 });
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

function providerClaims(
  provider: Provider,
  input: { email: string; subject: string; name?: string },
): Record<string, unknown> {
  if (provider === 'google') {
    return {
      sub: input.subject,
      email: input.email,
      email_verified: true,
      name: input.name ?? 'Google User',
    };
  }
  return {
    sub: input.subject,
    tid: MICROSOFT_CONSUMER_TENANT_ID,
    email: input.email,
    email_verified: false,
    name: input.name ?? 'Microsoft User',
  };
}

function uniqueEmail(label: string, provider: Provider): string {
  const local = `${label}-${randomUUID()}`;
  return provider === 'microsoft' ? `${local}@hotmail.com` : `${local}@example.com`;
}

async function driveCallback(
  provider: Provider,
  input: { email: string; subject: string; name?: string },
): Promise<Response> {
  const state = randomUUID().replaceAll('-', '');
  await testDb.db
    .insertInto('verifications')
    .values({
      id: randomUUID(),
      identifier: state,
      value: JSON.stringify({
        callbackURL: SUCCESS_CALLBACK_URL,
        codeVerifier: 'a'.repeat(43),
        errorURL: ERROR_CALLBACK_URL,
        expiresAt: Date.now() + 600_000,
        oauthState: state,
      }),
      expires_at: new Date(Date.now() + 600_000),
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();

  const restore = installProviderFetchMock(provider, providerClaims(provider, input));
  try {
    const callback = new URL(`${BASE_URL}/api/auth/callback/${provider}`);
    callback.searchParams.set('code', 'fake-authorization-code');
    callback.searchParams.set('state', state);
    return await authApp.request(
      new Request(callback, {
        method: 'GET',
        headers: { cookie: `better-auth.state=${signStateCookie(state)}` },
        redirect: 'manual',
      }),
    );
  } finally {
    restore();
  }
}

function sessionCookie(response: Response): string | null {
  const setCookie = response.headers
    .getSetCookie()
    .find((value) => value.includes('session_token='));
  return setCookie?.split(';')[0] ?? null;
}

async function publicGetSession(cookie: string | null): Promise<unknown> {
  const response = await authApp.request(
    new Request(`${BASE_URL}/api/auth/get-session`, {
      method: 'GET',
      headers: cookie ? { cookie } : undefined,
    }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function expectCallbackDenied(response: Response): Promise<void> {
  expect([302, 303, 307]).toContain(response.status);
  expect(response.headers.get('location') ?? '').not.toContain('/dashboard');
  expect(sessionCookie(response)).toBeNull();
  expect(await publicGetSession(sessionCookie(response))).toBeNull();
}

async function seedUser(input: {
  tenant: string;
  email: string;
  name: string;
  verified?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await testDb.db
    .insertInto('users')
    .values({
      id,
      name: input.name,
      email: input.email,
      email_verified: input.verified ?? false,
      image: null,
      id_plataforma: input.tenant,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    })
    .execute();
  return id;
}

async function seedCredential(userId: string, email: string, tenant: string): Promise<void> {
  await testDb.db
    .insertInto('accounts')
    .values({
      id: randomUUID(),
      user_id: userId,
      provider_id: 'credential',
      account_id: `${tenant}::${email}`,
      password: 'foreign-credential-must-not-change',
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      scope: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    })
    .execute();
}

async function seedProviderAccount(
  userId: string,
  provider: Provider,
  subject: string,
): Promise<string> {
  const id = randomUUID();
  await testDb.db
    .insertInto('accounts')
    .values({
      id,
      user_id: userId,
      provider_id: provider,
      account_id: subject,
      password: null,
      access_token: 'provider-access-before',
      refresh_token: 'provider-refresh-before',
      id_token: 'provider-id-before',
      access_token_expires_at: new Date('2030-01-01T00:00:00.000Z'),
      refresh_token_expires_at: new Date('2030-01-02T00:00:00.000Z'),
      scope: 'scope-before',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    })
    .execute();
  return id;
}

async function seedSession(userId: string, token = randomUUID()): Promise<string> {
  await testDb.db
    .insertInto('sessions')
    .values({
      id: randomUUID(),
      user_id: userId,
      token,
      expires_at: new Date('2030-01-01T00:00:00.000Z'),
      ip_address: 'hashed-ip-must-not-change',
      user_agent: 'fixture-agent',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    })
    .execute();
  return token;
}

async function identitySnapshot(userIds: readonly string[]) {
  const users = await testDb.db
    .selectFrom('users')
    .selectAll()
    .where('id', 'in', [...userIds])
    .orderBy('id')
    .execute();
  const accounts = await testDb.db
    .selectFrom('accounts')
    .selectAll()
    .where('user_id', 'in', [...userIds])
    .orderBy('id')
    .execute();
  const sessions = await testDb.db
    .selectFrom('sessions')
    .selectAll()
    .where('user_id', 'in', [...userIds])
    .orderBy('id')
    .execute();
  return { users, accounts, sessions };
}

async function productionAdapter(): Promise<DBAdapter> {
  const context = await (
    deps.auth as unknown as {
      $context: Promise<{ adapter: DBAdapter }>;
    }
  ).$context;
  return context.adapter;
}

describe('OAuth tenant boundary — real production composition (aperture-k2y3l)', () => {
  it('foreign-only same email fails closed before credential, provider, or session writes', async () => {
    const provider: Provider = 'google';
    const email = uniqueEmail('foreign-only', provider);
    const foreignId = await seedUser({
      tenant: ID_PLATAFORMA_EUCASEI,
      email,
      name: 'Foreign Only',
    });
    await seedCredential(foreignId, email, ID_PLATAFORMA_EUCASEI);
    await seedSession(foreignId);
    const before = await identitySnapshot([foreignId]);

    const response = await driveCallback(provider, {
      email,
      subject: `foreign-only-${randomUUID()}`,
    });

    await expectCallbackDenied(response);
    expect(await identitySnapshot([foreignId])).toEqual(before);
    const matches = await testDb.db
      .selectFrom('users')
      .select(['id', 'id_plataforma'])
      .where('email', '=', email)
      .execute();
    expect(matches).toEqual([{ id: foreignId, id_plataforma: ID_PLATAFORMA_EUCASEI }]);
  });

  it('duplicate cross-tenant email with no provider link fails closed for both identities', async () => {
    const provider: Provider = 'microsoft';
    const email = uniqueEmail('duplicate', provider);
    const foreignId = await seedUser({
      tenant: ID_PLATAFORMA_EUCASEI,
      email,
      name: 'Duplicate Foreign',
    });
    const localId = await seedUser({
      tenant: ID_PLATAFORMA_EUNENEM,
      email,
      name: 'Duplicate Local',
    });
    await seedCredential(foreignId, email, ID_PLATAFORMA_EUCASEI);
    await seedCredential(localId, email, ID_PLATAFORMA_EUNENEM);
    await seedSession(foreignId);
    await seedSession(localId);
    const before = await identitySnapshot([foreignId, localId]);

    const response = await driveCallback(provider, {
      email,
      subject: `duplicate-${randomUUID()}`,
    });

    await expectCallbackDenied(response);
    expect(await identitySnapshot([foreignId, localId])).toEqual(before);
  });

  it.each<Provider>([
    'google',
    'microsoft',
  ])('an exact %s provider account owned by a foreign tenant is denied before token refresh', async (provider) => {
    const email = uniqueEmail('foreign-linked', provider);
    const subject = `foreign-linked-${provider}-${randomUUID()}`;
    const foreignId = await seedUser({
      tenant: ID_PLATAFORMA_EUCASEI,
      email,
      name: 'Foreign Linked',
      verified: true,
    });
    const localId = await seedUser({
      tenant: ID_PLATAFORMA_EUNENEM,
      email,
      name: 'Local Collision',
    });
    await seedCredential(foreignId, email, ID_PLATAFORMA_EUCASEI);
    await seedProviderAccount(foreignId, provider, subject);
    await seedSession(foreignId);
    const before = await identitySnapshot([foreignId, localId]);

    const response = await driveCallback(provider, { email, subject });

    await expectCallbackDenied(response);
    expect(await identitySnapshot([foreignId, localId])).toEqual(before);
  });

  it.each<Provider>([
    'google',
    'microsoft',
  ])('an exact %s provider account owned by EUNENEM remains a valid returning flow', async (provider) => {
    const email = uniqueEmail('local-linked', provider);
    const subject = `local-linked-${provider}-${randomUUID()}`;
    const localId = await seedUser({
      tenant: ID_PLATAFORMA_EUNENEM,
      email,
      name: 'Local Linked',
      verified: true,
    });
    const foreignId = await seedUser({
      tenant: ID_PLATAFORMA_EUCASEI,
      email,
      name: 'Foreign Duplicate',
      verified: true,
    });
    await seedProviderAccount(localId, provider, subject);
    await seedCredential(foreignId, email, ID_PLATAFORMA_EUCASEI);
    await seedSession(foreignId);
    const foreignBefore = await identitySnapshot([foreignId]);

    const response = await driveCallback(provider, { email, subject });

    const cookie = sessionCookie(response);
    expect(cookie).not.toBeNull();
    expect(response.headers.get('location') ?? '').toContain('/dashboard');
    const resolved = (await publicGetSession(cookie)) as {
      user?: { id?: string; idPlataforma?: string };
    };
    expect(resolved.user).toMatchObject({
      id: localId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
    });
    expect(await identitySnapshot([foreignId])).toEqual(foreignBefore);
  });

  it.each<Provider>([
    'google',
    'microsoft',
  ])('a sole unlinked EUNENEM %s identity links and establishes a local session', async (provider) => {
    const email = uniqueEmail('local-unlinked', provider);
    const subject = `local-unlinked-${provider}-${randomUUID()}`;
    const localId = await seedUser({
      tenant: ID_PLATAFORMA_EUNENEM,
      email,
      name: 'Local Unlinked',
    });

    const response = await driveCallback(provider, { email, subject });

    const cookie = sessionCookie(response);
    expect(cookie).not.toBeNull();
    const resolved = (await publicGetSession(cookie)) as {
      user?: { id?: string; idPlataforma?: string };
    };
    expect(resolved.user).toMatchObject({
      id: localId,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
    });
    const linked = await testDb.db
      .selectFrom('accounts')
      .select(['user_id', 'provider_id', 'account_id'])
      .where('provider_id', '=', provider)
      .where('account_id', '=', subject)
      .executeTakeFirstOrThrow();
    expect(linked.user_id).toBe(localId);
  });

  it.each<Provider>([
    'google',
    'microsoft',
  ])('a brand-new %s identity creates only an EUNENEM user and session', async (provider) => {
    const email = uniqueEmail('brand-new', provider);
    const subject = `brand-new-${provider}-${randomUUID()}`;

    const response = await driveCallback(provider, { email, subject });

    const cookie = sessionCookie(response);
    expect(cookie).not.toBeNull();
    const created = await testDb.db
      .selectFrom('users')
      .select(['id', 'id_plataforma'])
      .where('email', '=', email)
      .execute();
    expect(created).toHaveLength(1);
    expect(created[0]?.id_plataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(
      await testDb.db
        .selectFrom('accounts')
        .select(['user_id', 'provider_id', 'account_id'])
        .where('provider_id', '=', provider)
        .where('account_id', '=', subject)
        .execute(),
    ).toEqual([
      {
        user_id: created[0]?.id,
        provider_id: provider,
        account_id: subject,
      },
    ]);
    const resolved = (await publicGetSession(cookie)) as {
      user?: { id?: string; idPlataforma?: string };
    };
    expect(resolved.user).toMatchObject({
      id: created[0]?.id,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
    });
  });

  it('a signed foreign cookie yields null get-session/resolver and cannot reach admin writes', async () => {
    const email = `signed-foreign-${randomUUID()}@test.local`;
    let foreignMagicLinkUrl: string | null = null;
    const foreignAuth = criarAuth(testDb.db, {
      secret: SECRET,
      baseURL: BASE_URL,
      trustedOrigins: [BASE_URL],
      useSecureCookies: false,
      idPlataformaPadrao: ID_PLATAFORMA_EUCASEI,
      sendMagicLink: async ({ url }) => {
        foreignMagicLinkUrl = url;
      },
    });
    await foreignAuth.api.signInMagicLink({
      body: { email, name: 'Signed Foreign', callbackURL: '/dashboard' },
      headers: new Headers({ origin: BASE_URL }),
    });
    expect(foreignMagicLinkUrl, 'foreign auth sender must receive a verification URL').toBeTruthy();
    const verifyResponse = await foreignAuth.handler(
      new Request(foreignMagicLinkUrl as string, {
        method: 'GET',
        redirect: 'manual',
      }),
    );
    const cookie =
      verifyResponse.headers
        .getSetCookie()
        .find((value) => value.includes('session_token='))
        ?.split(';')[0] ?? null;
    expect(cookie).not.toBeNull();
    const foreign = await testDb.db
      .selectFrom('users')
      .select(['id', 'id_plataforma'])
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    expect(foreign.id_plataforma).toBe(ID_PLATAFORMA_EUCASEI);
    const before = await identitySnapshot([foreign.id]);

    expect(await publicGetSession(cookie)).toBeNull();
    const headers = new Headers({ cookie: cookie as string });
    expect(await resolverUsuarioAutenticadoOuNull(deps, headers)).toBeNull();

    const categorySlug = `foreign-cookie-${randomUUID()}`;
    const auditBefore = await testDb.db
      .selectFrom('catalogo_admin_audit_events')
      .select('id')
      .execute();
    const context: TrpcContext = {
      deps,
      headers,
      resHeaders: new Headers(),
    };
    await expect(
      appRouter.createCaller(context).admin.catalog.createCategory({
        slug: categorySlug,
        label: 'Must Not Exist',
        position: 0,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(
      await testDb.db
        .selectFrom('catalogo_categorias')
        .select('id')
        .where('slug', '=', categorySlug)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await testDb.db.selectFrom('catalogo_admin_audit_events').select('id').execute(),
    ).toEqual(auditBefore);
    expect(await identitySnapshot([foreign.id])).toEqual(before);
  });

  it('preserves projected/joined account reads while validating the forced owner join', async () => {
    const email = uniqueEmail('projected-read', 'google');
    const localId = await seedUser({
      tenant: ID_PLATAFORMA_EUNENEM,
      email,
      name: 'Projected Local',
    });
    const accountId = await seedProviderAccount(localId, 'google', `projected-${randomUUID()}`);
    const adapter = await productionAdapter();

    expect(
      await adapter.findOne<{ id: string }>({
        model: 'account',
        where: [{ field: 'id', value: accountId }],
        select: ['id'],
      }),
    ).toEqual({ id: accountId });
    expect(
      await adapter.findOne<{
        id: string;
        user: { id: string; idPlataforma: string };
      }>({
        model: 'account',
        where: [{ field: 'id', value: accountId }],
        select: ['id'],
        join: { user: { limit: 1 } },
      }),
    ).toMatchObject({
      id: accountId,
      user: {
        id: localId,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
      },
    });
  });

  it.each([
    'update',
    'delete',
  ] as const)('rejects a broad account %s before it can touch local and foreign rows', async (operation) => {
    const localId = await seedUser({
      tenant: ID_PLATAFORMA_EUNENEM,
      email: uniqueEmail('broad-local', 'google'),
      name: 'Broad Local',
    });
    const foreignId = await seedUser({
      tenant: ID_PLATAFORMA_EUCASEI,
      email: uniqueEmail('broad-foreign', 'google'),
      name: 'Broad Foreign',
    });
    await seedProviderAccount(localId, 'google', `broad-local-${randomUUID()}`);
    await seedProviderAccount(foreignId, 'google', `broad-foreign-${randomUUID()}`);
    const before = await identitySnapshot([localId, foreignId]);
    const adapter = await productionAdapter();
    const where = [{ field: 'providerId', value: 'google' }];

    const attempt =
      operation === 'update'
        ? adapter.update({
            model: 'account',
            where,
            update: { accessToken: 'must-not-write' },
          })
        : adapter.delete({ model: 'account', where });
    await expect(attempt).rejects.toThrow(
      'Better Auth tenant boundary rejected the identity operation',
    );
    expect(await identitySnapshot([localId, foreignId])).toEqual(before);
  });
});
