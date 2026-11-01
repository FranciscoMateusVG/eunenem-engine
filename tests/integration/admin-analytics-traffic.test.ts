import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AdminTrafficReader } from '../../apps/eunenem-server/server/admin-analytics-traffic.js';
import { buildServerDeps, loadEnv } from '../../apps/eunenem-server/server/auth/setup.js';
import { serializeClientRuntimeEnv } from '../../apps/eunenem-server/server/client-runtime-env.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const config = {
  MIXPANEL_PROJECT_ID: '4045181',
  MIXPANEL_API_REGION: 'US',
  MIXPANEL_SERVICE_ACCOUNT_USERNAME: 'fixture-reader',
  MIXPANEL_SERVICE_ACCOUNT_SECRET: 'fixture-password',
};
const now = new Date('2038-10-01T04:00:00Z'); // Sep 30 in Pacific; Oct 1 in SP
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.teardown();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function response(url: URL) {
  const event = url.searchParams.get('event');
  const segmented = url.searchParams.has('on');
  return Response.json({
    data: {
      values: {
        [segmented ? 'google' : (event ?? 'event')]: {
          '2038-09-01': event === 'conta_criada' ? 3 : 20,
          '2038-09-30': 2,
        },
      },
    },
  });
}
it('production composition wires real reader, tRPC admin gate, Pacific calendar and server-only secrets', async () => {
  const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://mixpanel.com');
    expect(url.pathname).toBe('/api/query/segmentation');
    expect(url.searchParams.get('project_id')).toBe('4045181');
    expect(url.searchParams.get('from_date')).toBe('2037-10-01');
    expect(url.searchParams.get('to_date')).toBe('2038-09-30');
    expect(url.searchParams.get('unit')).toBe('day');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      `Basic ${Buffer.from('fixture-reader:fixture-password').toString('base64')}`,
    );
    return response(url);
  });
  vi.stubGlobal('fetch', http);
  const env = loadEnv({
    ...config,
    DATABASE_URL: t.connectionUri,
    NODE_ENV: 'development',
    BETTER_AUTH_SECRET: 'test-secret-minimum-32-characters-123456',
    BETTER_AUTH_URL: 'http://localhost:3001',
    TRUSTED_ORIGINS: 'http://localhost:3001',
  });
  const deps = buildServerDeps(env);
  try {
    expect(deps.adminTraffic).toBeInstanceOf(AdminTrafficReader);
    const auth = adminAuthOverrides();
    const context = {
      deps: { ...deps, ...auth.depsOverrides, clock: () => now },
      headers: auth.headers,
      resHeaders: new Headers(),
    };
    const denied = appRouter.createCaller({
      ...context,
      deps: { ...context.deps, adminAllowedEmails: new Set() },
    });
    await expect(denied.admin.analytics.trafego()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(http).not.toHaveBeenCalled();
    const caller = appRouter.createCaller(context);
    const [three, six] = await Promise.all([
      caller.admin.analytics.trafego({ meses: 3 }),
      caller.admin.analytics.trafego({ meses: 6 }),
    ]);
    expect(three.disponivel).toBe(true);
    expect(three.hoje).toBe('2038-09-30');
    expect(three.timezone).toBe('America/Los_Angeles');
    expect(three.meses).toHaveLength(3);
    expect(six.meses).toHaveLength(6);
    expect(three.totais).toEqual({
      visitas: 22,
      cadastros: 5,
      visitantes: null,
      conversaoPct: null,
    });
    expect(three.fontes).toEqual([{ fonte: 'Google', visitas: 22, cadastros: 5 }]);
    expect(three.semanas.reduce((n, row) => n + row.visitas, 0)).toBe(22);
    await caller.admin.analytics.trafego({ meses: 12 });
    expect(http).toHaveBeenCalledTimes(4); // all periods share 12m snapshot + in-flight cache
    expect(JSON.stringify(three)).not.toContain('fixture-reader');
    expect(JSON.stringify(three)).not.toContain('fixture-password');
    expect(serializeClientRuntimeEnv(config, undefined)).toBe('{}');
  } finally {
    await deps.db.destroy();
  }
});
it('unconfigured, 429, malformed and oversized responses fail closed with negative cache and no upstream text', async () => {
  const unused = vi.fn<typeof fetch>();
  expect((await new AdminTrafficReader({}, unused).load(now, 3)).disponivel).toBe(false);
  expect(unused).not.toHaveBeenCalled();
  for (const bad of [
    () => new Response('fixture-password upstream failure', { status: 429 }),
    () => Response.json({ error: 'fixture-password' }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    () => Response.json({ data: { values: { bad: { '2038-09-01': -1 } } } }),
  ]) {
    const http = vi.fn(async () => bad());
    const reader = new AdminTrafficReader(config, http);
    const result = await reader.load(now, 3);
    expect(result.disponivel).toBe(false);
    expect(result.totais.visitas).toBe(0);
    expect(result.motivo).toContain('indisponível');
    expect(JSON.stringify(result)).not.toContain('fixture-password');
    await reader.load(new Date(now.getTime() + 60_000), 12);
    expect(http).toHaveBeenCalledTimes(4);
  }
});
it('whole refresh timeout aborts all requests and cache expires', async () => {
  vi.useFakeTimers();
  const http = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('fixture-password')), {
          once: true,
        });
      }),
  );
  const reader = new AdminTrafficReader(config, http);
  const pending = reader.load(now, 3);
  await vi.advanceTimersByTimeAsync(8001);
  expect((await pending).disponivel).toBe(false);
  expect(http).toHaveBeenCalledTimes(4);
  http.mockImplementation(async (input) => response(new URL(String(input))));
  expect((await reader.load(new Date(now.getTime() + 5 * 60_000 + 1), 3)).disponivel).toBe(true);
  expect(http).toHaveBeenCalledTimes(8);
});
