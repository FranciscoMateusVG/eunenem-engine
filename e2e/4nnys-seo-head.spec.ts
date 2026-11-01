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

test('robots and sitemap expose institutional pages without changing existing indexing', async ({
  request,
}) => {
  const robots = await request.get('/robots.txt', { maxRedirects: 0 });
  expect(robots.status()).toBe(200);
  expect(robots.headers()['content-type']).toContain('text/plain');
  const text = await robots.text();
  expect(text).toContain('User-agent: *');
  for (const path of ['/painel', '/admin', '/login', '/campanhas', '/api/']) {
    expect(text).toContain(`Disallow: ${path}`);
  }
  expect(text).not.toMatch(/^Disallow: \/pagina\/?$/m);
  const sitemapUrl = text.match(/^Sitemap: (.+)$/m)?.[1];
  expect(sitemapUrl).toBeDefined();
  const sitemap = await request.get('/sitemap.xml', { maxRedirects: 0 });
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toContain('application/xml');
  const xml = await sitemap.text();
  expect(xml).toContain('http://www.sitemaps.org/schemas/sitemap/0.9');
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const origin = new URL(sitemapUrl ?? '').origin;
  expect(locations).toEqual(
    expect.arrayContaining(
      ['/', '/faq', '/taxas-e-prazos', '/termos-de-uso'].map((p) => `${origin}${p}`),
    ),
  );
  expect(
    locations.every(
      (location) =>
        location &&
        (new URL(location).pathname.startsWith('/pagina/') ||
          ['/', '/faq', '/taxas-e-prazos', '/termos-de-uso'].includes(new URL(location).pathname)),
    ),
  ).toBe(true);
  // The sitemap is not a new privacy/indexing policy for existing family pages.
  const familyHtml = await (await request.get('/pagina/maria')).text();
  expect(familyHtml).not.toContain('name="robots" content="noindex');
});
