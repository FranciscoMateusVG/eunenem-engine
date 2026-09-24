import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createLegacyGuestRedirectMiddleware } from '../../../apps/eunenem-server/server/legacy-guest-redirect.js';

const ENGINE_ORIGIN = 'https://staging.eunenem.com';
const LEGACY_ORIGIN = 'https://staging-legado.eunenem.com';
const UUID = 'cbbf5913-ca0d-428d-ac43-792d33f4c70d';
const FIFTY_CHAR_SLUG = `a${'b'.repeat(48)}1`;

function testApp(legacySiteOrigin: string | undefined) {
  const app = new Hono();
  app.get('/faq', (c) => c.text('engine faq'));
  app.use('*', createLegacyGuestRedirectMiddleware(legacySiteOrigin));
  app.get('/', (c) => c.text('engine landing'));
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
  describe.each(['GET', 'HEAD'])('convites landing redirect (%s)', (method) => {
    it.each([
      '/convites',
      '/convites/',
      '/convites?utm_source=google&utm_campaign=cha%20de%20bebe&gclid=abc%2B123',
      '/convites/?utm_source=google&utm_source=email&next=https://example.com',
    ])('redirects %s to the same-origin root without a loop', async (path) => {
      for (const origin of [ENGINE_ORIGIN, 'https://eunenem.com']) {
        const app = testApp(LEGACY_ORIGIN);
        const response = await app.request(`${origin}${path}`, { method, redirect: 'manual' });
        const location = response.headers.get('location');

        expect(response.status).toBe(302);
        expect(location).toBe(`/${new URL(`${origin}${path}`).search}`);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe('');

        const destination = new URL(location ?? '', origin);
        expect(destination.origin).toBe(origin);
        const landing = await app.request(destination, { method, redirect: 'manual' });
        expect(landing.status).toBe(200);
        expect(landing.headers.get('location')).toBeNull();
        expect(await landing.text()).toBe(method === 'HEAD' ? '' : 'engine landing');
      }
    });

    it.each([
      undefined,
      '',
      ENGINE_ORIGIN,
      'javascript:alert(1)',
    ])('does not depend on legacy origin %s', async (legacyOrigin) => {
      const response = await testApp(legacyOrigin).request(
        `${ENGINE_ORIGIN}/convites?utm_source=ad`,
        {
          method,
        },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/?utm_source=ad');
    });
  });

  it.each([
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
  ])('does not redirect %s /convites', async (method) => {
    const response = await request('/convites', { method });
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

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
    ['/123-bebe', `${LEGACY_ORIGIN}/123-bebe`],
    ['/convites-da-ana', `${LEGACY_ORIGIN}/convites-da-ana`],
    ['/convites/checkout?item=2', `${LEGACY_ORIGIN}/convites/checkout?item=2`],
    [`/${UUID}/checkout?item=2`, `${LEGACY_ORIGIN}/${UUID}/checkout?item=2`],
    ['/casamento-da-ana/checkout?item=2', `${LEGACY_ORIGIN}/casamento-da-ana/checkout?item=2`],
    [`/${FIFTY_CHAR_SLUG}/checkout`, `${LEGACY_ORIGIN}/${FIFTY_CHAR_SLUG}/checkout`],
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
    '/casal--feliz',
    '/casal-',
    `/a${'b'.repeat(50)}`,
  ])('does not redirect Engine, reserved, or invalid path %s', async (path) => {
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
