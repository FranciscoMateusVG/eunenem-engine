import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  createPainelAccessMiddleware,
  type PainelAccessDependencies,
} from '../../../apps/eunenem-server/server/painel-access.js';

const PRIVATE_SENTINEL = 'PRIVATE_OWNER_DASHBOARD';
const OWNER_ACCOUNT = 'owner-account';

function createTestApp(overrides: Partial<PainelAccessDependencies> = {}) {
  const deps: PainelAccessDependencies = {
    findOwnerAccountId: async () => OWNER_ACCOUNT,
    resolveSessionAccountId: async () => OWNER_ACCOUNT,
    campaignBelongsToOwner: async () => true,
    ...overrides,
  };
  const app = new Hono();
  app.use('/painel/*', createPainelAccessMiddleware(deps));
  app.get('*', (c) => c.html(PRIVATE_SENTINEL));
  return app;
}

function expectPrivateCacheHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

describe('painel SSR access middleware', () => {
  const routeKinds = [
    '/painel/helena',
    '/painel/helena/presentes',
    '/painel/helena/convite/preview',
  ];

  it.each(routeKinds)('redirects anonymous requests before private SSR: %s', async (path) => {
    const app = createTestApp({ resolveSessionAccountId: async () => null });
    const response = await app.request(path, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/pagina/helena');
    expect(await response.text()).not.toContain(PRIVATE_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it.each(routeKinds)('redirects authenticated non-owners: %s', async (path) => {
    const app = createTestApp({ resolveSessionAccountId: async () => 'different-account' });
    const response = await app.request(path, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(await response.text()).not.toContain(PRIVATE_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it.each(routeKinds)('renders private SSR only for the owner: %s', async (path) => {
    const response = await createTestApp().request(path);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(PRIVATE_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it('fails closed when session resolution throws', async () => {
    const app = createTestApp({
      resolveSessionAccountId: async () => {
        throw new Error('session store unavailable');
      },
    });
    const response = await app.request('/painel/helena');

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(PRIVATE_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it('returns a cache-safe 404 for an unknown owner', async () => {
    const response = await createTestApp({ findOwnerAccountId: async () => null }).request(
      '/painel/helena',
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(PRIVATE_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it('returns a cache-safe 404 for a campaign not owned by the slug owner', async () => {
    const response = await createTestApp({ campaignBelongsToOwner: async () => false }).request(
      '/painel/helena/c/campaign-2',
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(PRIVATE_SENTINEL);
    expectPrivateCacheHeaders(response);
  });
});
