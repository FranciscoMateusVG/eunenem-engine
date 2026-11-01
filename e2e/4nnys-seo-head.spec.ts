import { expect, test } from '@playwright/test';

// aperture-4nnys — Google must see title, site name and icons without JS, so
// these read the raw server HTML (request.get), not the hydrated DOM.
// Read-only and anonymous: safe on staging/prod.

test('landing HTML carries the branded title, site name and WebSite JSON-LD', async ({
  request,
}) => {
  const response = await request.get('/');
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain('<title>EuNeném · Lista de chá de bebê online</title>');
  expect(html).toMatch(/<meta name="description" content="[^"]{50,}" \/>/);
  expect(html).toContain('<meta property="og:site_name" content="EuNeném" />');
  const jsonLd = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1];
  expect(jsonLd).toBeDefined();
  expect(JSON.parse(jsonLd ?? '{}')).toMatchObject({ '@type': 'WebSite', name: 'EuNeném' });
  expect(html).toContain('<link rel="icon" href="/favicon.ico"');
  expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
});

test('inner routes get their own title, never the pathname', async ({ request }) => {
  const html = await (await request.get('/faq')).text();
  expect(html).toContain('<title>Perguntas frequentes · EuNeném</title>');
  expect(html).not.toContain('<title>eunenem · /faq</title>');
});

for (const [path, type] of [
  ['/favicon.ico', 'image/'],
  ['/favicon.svg', 'image/svg+xml'],
  ['/apple-touch-icon.png', 'image/png'],
  ['/icon-192.png', 'image/png'],
  ['/icon-512.png', 'image/png'],
  ['/icon-maskable-512.png', 'image/png'],
] as const) {
  test(`${path} is served`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain(type);
  });
}

test('web manifest is served and names EuNeném', async ({ request }) => {
  const response = await request.get('/site.webmanifest', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('manifest+json');
  const manifest = await response.json();
  expect(manifest).toMatchObject({ name: 'EuNeném', short_name: 'EuNeném', lang: 'pt-BR' });
  for (const icon of manifest.icons as Array<{ src: string }>) {
    expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  }
});
