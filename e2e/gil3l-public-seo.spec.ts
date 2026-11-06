import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';

// Synthetic local PG + real Hono SSR/Chromium. Never seed a remote deployment.
test.skip(
  Boolean(
    process.env.E2E_BASE_URL &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(process.env.E2E_BASE_URL),
  ),
  'local synthetic fixtures only',
);

test('all public list URL forms have personal metadata before JS, safe chrome after hydration', async ({
  request,
  page,
  seededData,
}) => {
  const db = createDatabase(
    process.env.E2E_DATABASE_URL ?? 'postgresql://frame:frame@localhost:54320/frame',
  );
  const campaignSlug = `cha-${randomUUID().slice(0, 8)}`;
  try {
    await db
      .updateTable('campanhas')
      .set({ slug: campaignSlug })
      .where('id', '=', seededData.idCampanha)
      .execute();
    await db
      .insertInto('perfil_campanhas')
      .values({ id: randomUUID(), id_campanha: seededData.idCampanha, nome_bebe: 'Lia & Lua' })
      .onConflict((oc) => oc.column('id_campanha').doUpdateSet({ nome_bebe: 'Lia & Lua' }))
      .execute();
    for (const suffix of ['', `/c/${seededData.idCampanha}`, `/${campaignSlug}`]) {
      const response = await request.get(`/pagina/${seededData.slug}${suffix}`);
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain('<title>Lista de presentes de Lia &amp; Lua · EuNeném</title>');
      expect(html).toContain(
        '<meta name="description" content="Presenteie Lia &amp; Lua pela lista',
      );
      expect(html).toContain(
        '<meta property="og:description" content="Presenteie Lia &amp; Lua pela lista',
      );
      expect(html).not.toContain('data-edit-field');
    }
    await page.goto(`/pagina/${seededData.slug}/${campaignSlug}`);
    await expect(page.locator('h1')).toContainText('Lia & Lua');
    await expect(page.locator('[data-edit-field]')).toHaveCount(0);
    await expect(page.locator('header [data-nosnippet]')).toHaveCount(1);
    const unknown = await request.get(`/pagina/${seededData.slug}/not-my-campaign`);
    expect(unknown.status()).toBe(404);
    expect(await unknown.text()).not.toContain('Lia &amp; Lua');
    await db
      .updateTable('usuarios')
      .set({ desativado_em: new Date() })
      .where('slug', '=', seededData.slug)
      .execute();
    const disabled = await request.get(`/pagina/${seededData.slug}`);
    expect(disabled.status()).toBe(404);
    expect(await disabled.text()).not.toContain('Lia &amp; Lua');
  } finally {
    await db.destroy();
  }
});

for (const size of [48, 96, 192]) {
  test(`favicon ${size} has correct HTTP MIME, dimensions, links and manifest`, async ({
    request,
  }) => {
    const src = `/favicon-${size}.png`;
    const response = await request.get(src, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
    const png = await response.body();
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    for (const path of ['/', '/faq', '/taxas-e-prazos', '/termos-de-uso']) {
      expect(await (await request.get(path)).text()).toContain(
        `href="${src}" type="image/png" sizes="${size}x${size}"`,
      );
    }
    const manifest = await (await request.get('/site.webmanifest')).json();
    expect(manifest.icons).toContainEqual({ src, sizes: `${size}x${size}`, type: 'image/png' });
  });
}
