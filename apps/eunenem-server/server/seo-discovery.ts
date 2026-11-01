import { Hono } from 'hono';
import type { Database } from '../../../src/adapters/database.js';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/index.js';

const INSTITUTIONAL_PATHS = ['/', '/faq', '/taxas-e-prazos', '/termos-de-uso'];
const PRIVATE_PATHS = [
  '/painel',
  '/admin',
  '/login',
  '/campanhas',
  '/api/',
  '/auth-demo',
  '/trpc-smoke',
  '/email/',
  '/avaliar-email',
  '/*/confirmar-presenca/',
  '/pagina/*/sucesso',
];

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Same ownership/active-account boundary as campaignPublicOwner, without N+1 reads. */
async function publicListEntries(db: Database) {
  const rows = await db
    .selectFrom('campanhas as c')
    .innerJoin('campanha_administradores as a', 'a.campanha_id', 'c.id')
    .innerJoin('campanha_membros_permissoes as m', (join) =>
      join.onRef('m.campanha_id', '=', 'c.id').onRef('m.id_conta', '=', 'a.id_usuario'),
    )
    .innerJoin('usuarios as u', 'u.id_conta', 'm.id_conta')
    .leftJoin('perfil_campanhas as p', 'p.id_campanha', 'c.id')
    .select([
      'c.id',
      'c.slug',
      'c.criada_em',
      'c.slug_alterado_em',
      'u.slug as owner_slug',
      'u.id_conta',
      'p.atualizado_em',
    ])
    .select((eb) =>
      eb
        .exists(
          eb
            .selectFrom('opcoes_contribuicao as o')
            .select('o.id')
            .whereRef('o.campanha_id', '=', 'c.id')
            .where('o.tipo', '=', 'presente'),
        )
        .as('has_presentes'),
    )
    .where('c.id_plataforma', '=', ID_PLATAFORMA_EUNENEM)
    .where('u.id_plataforma', '=', ID_PLATAFORMA_EUNENEM)
    .where('u.desativado_em', 'is', null)
    .where('m.papel', '=', 'owner')
    .orderBy('c.criada_em', 'asc')
    .orderBy('c.id', 'asc')
    .orderBy('u.id_conta', 'asc')
    .execute();
  const oldestByOwner = new Map<string, string>();
  const seen = new Set<string>();
  const entries: { path: string; lastmod: string }[] = [];
  for (const row of rows) {
    // A bare owner URL resolves their oldest owned campaign, including one
    // without a presente option; never point a later list at that wrong URL.
    if (!oldestByOwner.has(row.id_conta)) oldestByOwner.set(row.id_conta, row.id);
    if (!row.has_presentes || seen.has(row.id)) continue;
    seen.add(row.id);
    const base = `/pagina/${encodeURIComponent(row.owner_slug)}`;
    const path =
      oldestByOwner.get(row.id_conta) === row.id
        ? base
        : row.slug
          ? `${base}/${encodeURIComponent(row.slug)}`
          : `${base}/c/${row.id}`;
    const lastmod = new Date(
      Math.max(
        ...[row.criada_em, row.slug_alterado_em, row.atualizado_em]
          .filter((d): d is Date => d !== null)
          .map((d) => d.getTime()),
      ),
    ).toISOString();
    entries.push({ path, lastmod });
  }
  return entries;
}

/** Mounted before SSR. Trusted configured origin, never the request Host header. */
export function createSeoDiscoveryRoutes(db: Database, publicOrigin: string) {
  const origin = new URL(publicOrigin).origin;
  return new Hono()
    .get('/robots.txt', (c) =>
      c.text(
        [
          'User-agent: *',
          'Allow: /',
          ...PRIVATE_PATHS.map((path) => `Disallow: ${path}`),
          `Sitemap: ${origin}/sitemap.xml`,
          '',
        ].join('\n'),
      ),
    )
    .get('/sitemap.xml', async (c) => {
      const lists = await publicListEntries(db);
      // Static content has no reliable modification timestamp: omit optional
      // lastmod rather than claiming every request changed the page.
      const urls = [
        ...INSTITUTIONAL_PATHS.map((path) => `<url><loc>${xmlEscape(origin + path)}</loc></url>`),
        ...lists.map(
          ({ path, lastmod }) =>
            `<url><loc>${xmlEscape(origin + path)}</loc><lastmod>${lastmod}</lastmod></url>`,
        ),
      ];
      return c.body(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
        200,
        { 'Content-Type': 'application/xml; charset=UTF-8' },
      );
    });
}
