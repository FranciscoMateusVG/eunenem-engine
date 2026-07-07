/**
 * resolveRoute regression suite (aperture-8jcec).
 *
 * `resolveRoute(pathname)` in apps/eunenem-server/pages/App.tsx is the
 * single source of truth for routing, shared by server.tsx (HTTP status)
 * and client.tsx (hydration dispatch). It was previously UNTESTED.
 *
 * This suite pins the CURRENT route table so the multicampanha work
 * (spec §9) can prove `/painel/:slug`, `/pagina/:slug` and the `/admin/*`
 * drill-downs resolve unchanged. One forward-looking `/campanhas` test is
 * marked `it.fails` — it flips loudly when the sibling PR lands the route.
 *
 * Full route table under test (match order as in App.tsx):
 *   /                                → landing
 *   /termos-de-uso[/]                → termos-de-uso
 *   /trpc-smoke                      → trpc-smoke        (exact, no trailing /)
 *   /auth-demo                       → auth-demo         (exact, no trailing /)
 *   /faq                             → faq               (exact, no trailing /)
 *   /admin/usuario/:idConta[/]       → admin-usuario     (free-shape id)
 *   /admin/campanha/:idCampanha[/]   → admin-campanha    (free-shape id)
 *   /admin/contribuicao/:id[/]       → admin-contribuicao (free-shape id)
 *   /admin/pagamento/:id[/]          → admin-pagamento   (free-shape id)
 *   /admin/repasses/:idRepasse[/]    → admin-repasse-detail (free-shape id)
 *   /admin/repasses[/]               → admin-repasses
 *   /admin[/]                        → admin
 *   /pagina/:slug/sucesso[/]         → pagina-sucesso    (SLUG_REGEX-gated)
 *   /pagina/:slug[/]                 → pagina            (SLUG_REGEX-gated)
 *   /painel/:slug/convite/preview[/] → painel-convite-preview (SLUG_REGEX)
 *   /painel/:slug[/]                 → painel            (SLUG_REGEX-gated)
 *   /painel/:slug/:section[/]        → painel-section    (section ∈ PAINEL_SECTIONS)
 *   anything else                    → not-found
 *
 * SLUG_REGEX = /^[a-z][a-z0-9-]{2,29}$/ (mirror of the SlugUsuario VO):
 * 3-30 chars, lowercase-letter start, then [a-z0-9-]. The router never
 * URL-decodes — `%` fails the slug regex, and admin ids keep the raw
 * encoded string.
 */
import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../../apps/eunenem-server/pages/App.js';
import { PAINEL_SECTIONS } from '../../apps/eunenem-server/pages/lib/painelRoutes.js';

describe('resolveRoute — static routes', () => {
  it('root "/" → landing', () => {
    expect(resolveRoute('/')).toEqual({ kind: 'landing' });
  });

  it('/termos-de-uso → termos-de-uso (with and without trailing slash)', () => {
    expect(resolveRoute('/termos-de-uso')).toEqual({ kind: 'termos-de-uso' });
    expect(resolveRoute('/termos-de-uso/')).toEqual({ kind: 'termos-de-uso' });
  });

  it('/trpc-smoke → trpc-smoke (exact match only)', () => {
    expect(resolveRoute('/trpc-smoke')).toEqual({ kind: 'trpc-smoke' });
    // No trailing-slash tolerance on the dev-only exact routes.
    expect(resolveRoute('/trpc-smoke/')).toEqual({ kind: 'not-found' });
  });

  it('/auth-demo → auth-demo (exact match only)', () => {
    expect(resolveRoute('/auth-demo')).toEqual({ kind: 'auth-demo' });
    expect(resolveRoute('/auth-demo/')).toEqual({ kind: 'not-found' });
  });

  it('/faq → faq (exact match only)', () => {
    expect(resolveRoute('/faq')).toEqual({ kind: 'faq' });
    expect(resolveRoute('/faq/')).toEqual({ kind: 'not-found' });
  });
});

describe('resolveRoute — /admin/* (regression, spec §9)', () => {
  it('/admin → admin (with and without trailing slash)', () => {
    expect(resolveRoute('/admin')).toEqual({ kind: 'admin' });
    expect(resolveRoute('/admin/')).toEqual({ kind: 'admin' });
  });

  it('/admin/usuario/:idConta → admin-usuario with extracted id', () => {
    expect(resolveRoute('/admin/usuario/conta-123')).toEqual({
      kind: 'admin-usuario',
      idConta: 'conta-123',
    });
    expect(resolveRoute('/admin/usuario/conta-123/')).toEqual({
      kind: 'admin-usuario',
      idConta: 'conta-123',
    });
  });

  it('/admin/campanha/:idCampanha → admin-campanha with extracted id', () => {
    expect(resolveRoute('/admin/campanha/camp-9')).toEqual({
      kind: 'admin-campanha',
      idCampanha: 'camp-9',
    });
    expect(resolveRoute('/admin/campanha/camp-9/')).toEqual({
      kind: 'admin-campanha',
      idCampanha: 'camp-9',
    });
  });

  it('/admin/contribuicao/:idContribuicao → admin-contribuicao', () => {
    expect(resolveRoute('/admin/contribuicao/contrib-42')).toEqual({
      kind: 'admin-contribuicao',
      idContribuicao: 'contrib-42',
    });
  });

  it('/admin/pagamento/:idPagamento → admin-pagamento', () => {
    expect(resolveRoute('/admin/pagamento/pag-7')).toEqual({
      kind: 'admin-pagamento',
      idPagamento: 'pag-7',
    });
  });

  it('/admin/repasses → admin-repasses (list)', () => {
    expect(resolveRoute('/admin/repasses')).toEqual({ kind: 'admin-repasses' });
    expect(resolveRoute('/admin/repasses/')).toEqual({ kind: 'admin-repasses' });
  });

  it('/admin/repasses/:idRepasse → admin-repasse-detail (wins over the list route)', () => {
    expect(resolveRoute('/admin/repasses/rep-1')).toEqual({
      kind: 'admin-repasse-detail',
      idRepasse: 'rep-1',
    });
    expect(resolveRoute('/admin/repasses/rep-1/')).toEqual({
      kind: 'admin-repasse-detail',
      idRepasse: 'rep-1',
    });
  });

  it('admin ids are free-shape: UUIDs and URL-encoded segments pass through RAW (no decoding)', () => {
    expect(resolveRoute('/admin/usuario/0f6a2c1e-9b3d-4e5f-8a7b-1c2d3e4f5a6b')).toEqual({
      kind: 'admin-usuario',
      idConta: '0f6a2c1e-9b3d-4e5f-8a7b-1c2d3e4f5a6b',
    });
    // The router never URL-decodes — the encoded form is the param value.
    expect(resolveRoute('/admin/usuario/id%20with%20spaces')).toEqual({
      kind: 'admin-usuario',
      idConta: 'id%20with%20spaces',
    });
  });

  it('/admin/usuario/ (empty id) is NOT the bare admin page → not-found', () => {
    expect(resolveRoute('/admin/usuario/')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('/admin/campanha/')).toEqual({ kind: 'not-found' });
  });

  it('extra segments under admin drills → not-found', () => {
    expect(resolveRoute('/admin/usuario/a/b')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('/admin/repasses/rep-1/extra')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('/admin/unknown')).toEqual({ kind: 'not-found' });
  });
});

describe('resolveRoute — /pagina/:slug (regression, spec §9)', () => {
  it('/pagina/:slug → pagina with extracted slug', () => {
    expect(resolveRoute('/pagina/helena')).toEqual({ kind: 'pagina', slug: 'helena' });
    expect(resolveRoute('/pagina/helena/')).toEqual({ kind: 'pagina', slug: 'helena' });
  });

  it('/pagina/:slug/sucesso → pagina-sucesso (wins over the bare pagina rule)', () => {
    expect(resolveRoute('/pagina/helena/sucesso')).toEqual({
      kind: 'pagina-sucesso',
      slug: 'helena',
    });
    expect(resolveRoute('/pagina/helena/sucesso/')).toEqual({
      kind: 'pagina-sucesso',
      slug: 'helena',
    });
  });

  it('slug-regex gate: invalid slugs → not-found', () => {
    expect(resolveRoute('/pagina/Helena')).toEqual({ kind: 'not-found' }); // uppercase
    expect(resolveRoute('/pagina/ab')).toEqual({ kind: 'not-found' }); // too short (< 3)
    expect(resolveRoute('/pagina/1abc')).toEqual({ kind: 'not-found' }); // digit start
    expect(resolveRoute('/pagina/caf%C3%A9')).toEqual({ kind: 'not-found' }); // encoded → % fails regex
  });

  it('empty-ish slug and extra segments → not-found', () => {
    expect(resolveRoute('/pagina/')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('/pagina')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('/pagina/helena/sucesso/extra')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('/pagina/helena/outra')).toEqual({ kind: 'not-found' });
  });
});

describe('resolveRoute — /painel/:slug (regression, spec §9)', () => {
  it('/painel/:slug → painel with extracted slug', () => {
    expect(resolveRoute('/painel/minha-lista')).toEqual({
      kind: 'painel',
      slug: 'minha-lista',
    });
    expect(resolveRoute('/painel/minha-lista/')).toEqual({
      kind: 'painel',
      slug: 'minha-lista',
    });
  });

  it('every canonical section resolves: /painel/:slug/:section → painel-section', () => {
    for (const section of PAINEL_SECTIONS) {
      expect(resolveRoute(`/painel/helena/${section}`)).toEqual({
        kind: 'painel-section',
        slug: 'helena',
        section,
      });
    }
  });

  it('painel-section tolerates a trailing slash', () => {
    expect(resolveRoute('/painel/helena/lista/')).toEqual({
      kind: 'painel-section',
      slug: 'helena',
      section: 'lista',
    });
  });

  it('unknown sub-section under a valid slug → honest not-found', () => {
    expect(resolveRoute('/painel/helena/inexistente')).toEqual({ kind: 'not-found' });
  });

  it('/painel/:slug/convite/preview → painel-convite-preview (wins over section dispatch)', () => {
    expect(resolveRoute('/painel/helena/convite/preview')).toEqual({
      kind: 'painel-convite-preview',
      slug: 'helena',
    });
    expect(resolveRoute('/painel/helena/convite/preview/')).toEqual({
      kind: 'painel-convite-preview',
      slug: 'helena',
    });
    // ...while the bare /convite segment stays a plain painel-section.
    expect(resolveRoute('/painel/helena/convite')).toEqual({
      kind: 'painel-section',
      slug: 'helena',
      section: 'convite',
    });
  });

  it('slug-regex gate: invalid slugs → not-found', () => {
    expect(resolveRoute('/painel/Helena')).toEqual({ kind: 'not-found' }); // uppercase
    expect(resolveRoute('/painel/ab')).toEqual({ kind: 'not-found' }); // too short (< 3)
    expect(resolveRoute('/painel/-abc')).toEqual({ kind: 'not-found' }); // must start with a letter
    expect(resolveRoute('/painel/hel%20ena')).toEqual({ kind: 'not-found' }); // encoded → % fails regex
    // 31 chars — one past the VO's 30-char ceiling.
    expect(resolveRoute(`/painel/${'a'.repeat(31)}`)).toEqual({ kind: 'not-found' });
  });

  it('slug-regex boundaries that PASS: 3 chars and 30 chars', () => {
    expect(resolveRoute('/painel/abc')).toEqual({ kind: 'painel', slug: 'abc' });
    const max = `a${'b'.repeat(29)}`; // 30 chars
    expect(resolveRoute(`/painel/${max}`)).toEqual({ kind: 'painel', slug: max });
  });

  it('empty-ish slug and extra segments → not-found', () => {
    expect(resolveRoute('/painel/')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('/painel')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('/painel/helena/lista/extra')).toEqual({ kind: 'not-found' });
  });
});

describe('resolveRoute — catch-all', () => {
  it('unknown paths → not-found', () => {
    expect(resolveRoute('/nope')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('/pagina-falsa/helena')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('//')).toEqual({ kind: 'not-found' });
    expect(resolveRoute('')).toEqual({ kind: 'not-found' });
  });
});

describe('resolveRoute — multicampanha (aperture-8jcec)', () => {
  // Sentinel flipped from it.fails → it when aperture-g7l09 (PR #321) landed
  // the route — 2026-07-07, exactly the designed integration signal.
  it('/campanhas → { kind: "campanhas" } (with and without trailing slash)', () => {
    expect(resolveRoute('/campanhas')).toEqual({ kind: 'campanhas' });
    expect(resolveRoute('/campanhas/')).toEqual({ kind: 'campanhas' });
  });
});
