import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createLegacyGuestRedirectMiddleware } from '../../../apps/eunenem-server/server/legacy-guest-redirect.js';

const ENGINE_ORIGIN = 'https://staging.eunenem.com';
const LEGACY_ORIGIN = 'https://staging-legado.eunenem.com';
const UUID = 'cbbf5913-ca0d-428d-ac43-792d33f4c70d';

function testApp(legacySiteOrigin: string | undefined) {
  const app = new Hono();
  app.get('/faq', (c) => c.text('engine faq'));
  app.use('*', createLegacyGuestRedirectMiddleware(legacySiteOrigin));
  app.all('*', (c) => c.text('engine fallback', 404));
  return app;
}

async function request(
  path: string,
  init?: RequestInit,
  legacySiteOrigin: string | undefined = LEGACY_ORIGIN,
) {
  return testApp(legacySiteOrigin).request(`${ENGINE_ORIGIN}${path}`, {
    redirect: 'manual',
    ...init,
  });
}

describe('legacy guest-link redirect', () => {
  it('redirects the operator UUID example to the configured legacy origin and preserves query', async () => {
    const response = await request(`/${UUID}?utm_source=convite&gift=fralda`);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `${LEGACY_ORIGIN}/${UUID}?utm_source=convite&gift=fralda`,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['/casamento-da-ana', `${LEGACY_ORIGIN}/casamento-da-ana`],
    [`/${UUID}/checkout?item=2`, `${LEGACY_ORIGIN}/${UUID}/checkout?item=2`],
    ['/casamento-da-ana/checkout?item=2', `${LEGACY_ORIGIN}/casamento-da-ana/checkout?item=2`],
  ])('redirects eligible legacy path %s', async (path, location) => {
    const response = await request(path);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(location);
  });

  it('handles HEAD with the same 302 destination and no response body', async () => {
    const response = await request(`/${UUID}/checkout?item=2`, {
      method: 'HEAD',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${LEGACY_ORIGIN}/${UUID}/checkout?item=2`);
    expect(await response.text()).toBe('');
  });

  it('never redirects POST', async () => {
    const response = await request(`/${UUID}/checkout`, { method: 'POST' });
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it.each([
    '/',
    '/faq',
    '/pagina/casal-novo',
    '/pagina/casal-novo/invalid/extra',
    '/painel/casal-novo',
    '/painel/casal-novo/invalid',
    '/admin/unknown',
    '/api/unknown',
    '/auth/unknown',
    '/assets/unknown',
    '/public/client.js',
    '/products/item.png',
    '/listas-prontas/capa.png',
    '/casamento-da-ana/unknown',
  ])('leaves Engine routes and reserved namespaces at %s', async (path) => {
    const response = await request(path);
    expect(response.status).not.toBe(302);
    expect(response.headers.get('location')).toBeNull();
  });

  it.each([
    '',
    '//attacker.example',
    'javascript:alert(1)',
    'https://legacy.example/path',
    'https://legacy.example/?next=https://attacker.example',
    `${ENGINE_ORIGIN}/`,
    'http://staging.eunenem.com',
  ])('fails safely for missing, invalid, or self legacy origin %s', async (origin) => {
    const response = await request(`/${UUID}`, undefined, origin);
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('fails safely when the legacy origin is missing', async () => {
    const response = await testApp(undefined).request(`${ENGINE_ORIGIN}/${UUID}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('never lets host or query input choose the destination origin', async () => {
    const response = await testApp(LEGACY_ORIGIN).request(
      `https://attacker.example/${UUID}?next=https://attacker.example`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `${LEGACY_ORIGIN}/${UUID}?next=https://attacker.example`,
    );
  });
});
