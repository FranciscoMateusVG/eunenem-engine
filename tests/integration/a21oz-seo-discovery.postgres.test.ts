import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSeoDiscoveryRoutes } from '../../apps/eunenem-server/server/seo-discovery.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);
afterAll(async () => {
  await testDb?.teardown();
});
const origin = 'https://eunenem.com';

async function owner(slug: string, inactive = false, platform = ID_PLATAFORMA_EUNENEM) {
  const idConta = randomUUID();
  await testDb.db
    .insertInto('usuarios')
    .values({
      id: randomUUID(),
      id_conta: idConta,
      id_plataforma: platform,
      nome_exibicao: 'Synthetic owner',
      email: `${slug}@example.test`,
      slug,
      desativado_em: inactive ? new Date() : null,
    })
    .execute();
  return idConta;
}
async function member(campaign: string, conta: string, papel = 'owner', linked = true) {
  if (linked)
    await testDb.db
      .insertInto('campanha_administradores')
      .values({ campanha_id: campaign, id_usuario: conta })
      .execute();
  await testDb.db
    .insertInto('campanha_membros_permissoes')
    .values({ campanha_id: campaign, id_conta: conta, papel })
    .execute();
}
async function campaign(
  conta: string,
  options: {
    slug?: string;
    date?: string;
    presentes?: boolean;
    platform?: string;
    papel?: string;
    linked?: boolean;
  } = {},
) {
  const id = randomUUID();
  await testDb.db
    .insertInto('campanhas')
    .values({
      id,
      titulo: 'Synthetic list',
      id_plataforma: options.platform ?? ID_PLATAFORMA_EUNENEM,
      slug: options.slug ?? null,
      criada_em: new Date(options.date ?? '2026-10-01T00:00:00Z'),
    })
    .execute();
  await member(id, conta, options.papel, options.linked);
  if (options.presentes !== false)
    await testDb.db
      .insertInto('opcoes_contribuicao')
      .values({ id: randomUUID(), campanha_id: id, tipo: 'presente' })
      .execute();
  return id;
}

describe('SEO discovery through HTTP + real PostgreSQL', () => {
  it('lists active public owners once and never leaks invited, inactive, orphaned or other-platform lists', async () => {
    const active = await owner('seo-active');
    const first = await campaign(active);
    await campaign(active, { slug: 'segundo-cha', date: '2026-10-02T00:00:00Z' });
    const third = await campaign(active, { date: '2026-10-03T00:00:00Z' });
    await testDb.db
      .insertInto('perfil_campanhas')
      .values({
        id: randomUUID(),
        id_campanha: first,
        atualizado_em: new Date('2026-10-05T12:00:00Z'),
        nome_bebe: 'Never include personal content',
      })
      .execute();
    await member(first, await owner('seo-invited'), 'membro');
    await campaign(await owner('seo-offline', true));
    await campaign(await owner('seo-orphan'), { linked: false });
    await campaign(await owner('seo-memberonly'), { papel: 'membro' });
    const noOptionOwner = await owner('seo-no-option');
    await campaign(noOptionOwner, { presentes: false });
    await campaign(noOptionOwner, { slug: 'valid-list', date: '2026-10-04T00:00:00Z' });
    const platform = randomUUID();
    await campaign(await owner('seo-other-platform', false, platform), { platform });
    const offlineOwner = await owner('seo-offline-coowner', true);
    const shared = await campaign(offlineOwner);
    const coOwnerA = await owner('seo-active-coowner');
    const coOwnerB = await owner('seo-second-coowner');
    await member(shared, coOwnerA);
    await member(shared, coOwnerB);
    const publicCoOwner =
      coOwnerA.localeCompare(coOwnerB) < 0 ? 'seo-active-coowner' : 'seo-second-coowner';

    const app = createSeoDiscoveryRoutes(testDb.db, `${origin}/`);
    const res = await app.request('https://untrusted.example/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/xml');
    const xml = await res.text();
    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locations).toEqual(
      expect.arrayContaining([
        `${origin}/`,
        `${origin}/faq`,
        `${origin}/taxas-e-prazos`,
        `${origin}/termos-de-uso`,
        `${origin}/pagina/seo-active`,
        `${origin}/pagina/seo-active/segundo-cha`,
        `${origin}/pagina/seo-active/c/${third}`,
        `${origin}/pagina/${publicCoOwner}`,
        `${origin}/pagina/seo-no-option/valid-list`,
      ]),
    );
    expect(locations).toHaveLength(9);
    expect(locations).not.toContain(`${origin}/pagina/seo-no-option`);
    expect(xml).toContain('<lastmod>2026-10-05T12:00:00.000Z</lastmod>');
    for (const secret of [
      'seo-invited',
      'seo-offline',
      'seo-orphan',
      'seo-memberonly',
      'seo-other-platform',
      'Never include personal content',
      'untrusted.example',
    ])
      expect(xml).not.toContain(secret);
    // No stale global cache: deactivating the owner removes all their lists.
    await testDb.db
      .updateTable('usuarios')
      .set({ desativado_em: new Date() })
      .where('id_conta', '=', active)
      .execute();
    expect(await (await app.request('/sitemap.xml')).text()).not.toContain('/pagina/seo-active<');
  });

  it('robots points at configured origin and blocks private/transactional routes, not public lists', async () => {
    const app = createSeoDiscoveryRoutes(testDb.db, origin);
    const res = await app.request('https://untrusted.example/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain(`Sitemap: ${origin}/sitemap.xml`);
    for (const path of [
      '/painel',
      '/admin',
      '/login',
      '/campanhas',
      '/api/',
      '/email/',
      '/*/confirmar-presenca/',
      '/pagina/*/sucesso',
    ])
      expect(text).toContain(`Disallow: ${path}`);
    expect(text).not.toMatch(/^Disallow: \/pagina\/?$/m);
    expect(text).not.toContain('untrusted.example');
  });
});
