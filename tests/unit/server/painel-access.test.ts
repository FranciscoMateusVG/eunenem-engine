import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import {
  createPainelAccessMiddleware,
  type PainelAccessDependencies,
} from '../../../apps/eunenem-server/server/painel-access.js';

const SSR_SENTINEL = 'SSR_PAGE_RENDERED';
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
  app.get('*', (c) => c.html(SSR_SENTINEL));
  return app;
}

function expectPrivateCacheHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

describe('painel SSR access middleware', () => {
  const routeKinds = ['/painel/helena', '/painel/helena/presentes'];

  it.each(routeKinds)('redirects anonymous requests before private SSR: %s', async (path) => {
    const app = createTestApp({ resolveSessionAccountId: async () => null });
    const response = await app.request(path, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/pagina/helena');
    expect(await response.text()).not.toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it.each(routeKinds)('redirects authenticated non-owners: %s', async (path) => {
    const app = createTestApp({ resolveSessionAccountId: async () => 'different-account' });
    const response = await app.request(path, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(await response.text()).not.toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it.each(routeKinds)('renders private SSR only for the owner: %s', async (path) => {
    const response = await createTestApp().request(path);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(SSR_SENTINEL);
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
    expect(await response.text()).not.toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it('returns a cache-safe 404 for an unknown owner', async () => {
    const response = await createTestApp({ findOwnerAccountId: async () => null }).request(
      '/painel/helena',
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it('returns a cache-safe 404 for a campaign not owned by the slug owner', async () => {
    const response = await createTestApp({ campaignBelongsToOwner: async () => false }).request(
      '/painel/helena/c/campaign-2',
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it.each([
    null,
    'different-account',
  ])('redirects a private campaign route for viewer %s before checking campaign ownership', async (sessionAccountId) => {
    const campaignBelongsToOwner = vi.fn(async () => false);
    const app = createTestApp({
      resolveSessionAccountId: async () => sessionAccountId,
      campaignBelongsToOwner,
    });
    const response = await app.request('/painel/helena/c/campaign-2', {
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/pagina/helena');
    expect(campaignBelongsToOwner).not.toHaveBeenCalled();
    expectPrivateCacheHeaders(response);
  });

  it.each([
    null,
    'different-account',
  ])('renders a bare convite preview for a viewer with session %s', async (sessionAccountId) => {
    const app = createTestApp({ resolveSessionAccountId: async () => sessionAccountId });
    const response = await app.request('/painel/helena/convite/preview');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it('renders a campaign convite preview anonymously after ownership validation', async () => {
    const app = createTestApp({ resolveSessionAccountId: async () => null });
    const response = await app.request('/painel/helena/c/campaign-2/convite/preview');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it('does not consult the session store for a public convite preview', async () => {
    const app = createTestApp({
      resolveSessionAccountId: async () => {
        throw new Error('session store unavailable');
      },
    });
    const response = await app.request('/painel/helena/convite/preview');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it('returns 404 for an unknown preview slug', async () => {
    const response = await createTestApp({ findOwnerAccountId: async () => null }).request(
      '/painel/unknown/convite/preview',
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });

  it('returns 404 for a preview campaign not owned by the slug owner', async () => {
    const response = await createTestApp({ campaignBelongsToOwner: async () => false }).request(
      '/painel/helena/c/campaign-2/convite/preview',
    );

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SSR_SENTINEL);
    expectPrivateCacheHeaders(response);
  });
});
