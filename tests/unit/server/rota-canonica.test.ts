/**
 * aperture-ai8vg — canonical route templates: every App.tsx route family maps
 * to a fixed template with no slug / id / query / token, and to an audience.
 */
import { describe, expect, it } from 'vitest';
import {
  idCampanhaParaPageView,
  pageViewProps,
  publicoDaRota,
  ROTA_NAO_ENCONTRADA,
  rotaCanonica,
} from '../../../apps/eunenem-server/pages/lib/rota-canonica.js';

const UUID = '3f1c9a1e-0000-4000-8000-000000000001';

describe('rotaCanonica', () => {
  it.each([
    ['/', '/'],
    ['/termos-de-uso', '/termos-de-uso'],
    ['/termos-de-uso/', '/termos-de-uso'],
    ['/faq', '/faq'],
    ['/campanhas', '/campanhas'],
    ['/trpc-smoke', '/trpc-smoke'],
    ['/auth-demo', '/auth-demo'],
    ['/admin', '/admin/*'],
    ['/admin/pagamentos', '/admin/*'],
    [`/admin/usuario/${UUID}`, '/admin/*'],
    ['/pagina/francisco', '/pagina/:slug'],
    ['/pagina/francisco/', '/pagina/:slug'],
    [`/pagina/francisco/c/${UUID}`, '/pagina/:slug/c/:idCampanha'],
    ['/pagina/francisco/cha-da-maria', '/pagina/:slug/:campanhaSlug'],
    ['/pagina/francisco/sucesso', '/pagina/:slug/sucesso'],
    [`/francisco/confirmar-presenca/${UUID}`, '/:slug/confirmar-presenca/:idConvidado'],
    ['/painel/francisco', '/painel/:slug'],
    ['/painel/francisco/lista', '/painel/:slug/:section'],
    ['/painel/francisco/convite/preview', '/painel/:slug/convite/preview'],
    [`/painel/francisco/c/${UUID}`, '/painel/:slug/c/:idCampanha'],
    [`/painel/francisco/c/${UUID}/convidados`, '/painel/:slug/c/:idCampanha/:section'],
    [`/painel/francisco/c/${UUID}/convite/preview`, '/painel/:slug/c/:idCampanha/convite/preview'],
    ['/nada/aqui/mesmo', ROTA_NAO_ENCONTRADA],
    ['/__nao_encontrada__', ROTA_NAO_ENCONTRADA],
  ])('%s → %s', (pathname, rota) => {
    expect(rotaCanonica(pathname)).toBe(rota);
  });

  it('never leaks the dynamic segments, query string or hash', () => {
    const out = rotaCanonica(`/pagina/francisco/sucesso?sessionId=cs_live_1&idCampanha=${UUID}#x`);
    expect(out).toBe('/pagina/:slug/sucesso');
    expect(out).not.toContain('francisco');
    expect(out).not.toContain('cs_live');
    expect(out).not.toContain(UUID);
  });
});

describe('publicoDaRota', () => {
  it('classifies the audience from the template only', () => {
    expect(publicoDaRota('/')).toBe('visitante');
    expect(publicoDaRota('/pagina/:slug')).toBe('visitante');
    expect(publicoDaRota('/:slug/confirmar-presenca/:idConvidado')).toBe('convidado');
    expect(publicoDaRota('/painel/:slug/:section')).toBe('criador');
    expect(publicoDaRota('/campanhas')).toBe('criador'); // post-login hub
    expect(publicoDaRota('/admin/*')).toBe('admin');
    expect(publicoDaRota(ROTA_NAO_ENCONTRADA)).toBe('visitante');
  });
});

describe('idCampanhaParaPageView (public gift page)', () => {
  const RESOLVIDO = '3f1c9a1e-0000-4000-8000-00000000aaaa';

  it('bare /pagina/:slug: uses the server-resolved projection id', () => {
    expect(idCampanhaParaPageView(undefined, RESOLVIDO)).toBe(RESOLVIDO);
  });

  it('/c/:idCampanha: route id must equal the resolved id', () => {
    expect(idCampanhaParaPageView(RESOLVIDO, RESOLVIDO)).toBe(RESOLVIDO);
    expect(idCampanhaParaPageView(UUID, RESOLVIDO)).toBeUndefined();
  });

  it('no resolved id (null/undefined) → no attribution', () => {
    expect(idCampanhaParaPageView(undefined, null)).toBeUndefined();
    expect(idCampanhaParaPageView(UUID, undefined)).toBeUndefined();
  });
});

describe('pageViewProps', () => {
  it('carries rota + publico + only the opaque extras the caller passes', () => {
    expect(
      pageViewProps(`/painel/francisco/c/${UUID}/lista`, { section: 'lista', id_campanha: UUID }),
    ).toEqual({
      rota: '/painel/:slug/c/:idCampanha/:section',
      publico: 'criador',
      section: 'lista',
      id_campanha: UUID,
    });
    expect(pageViewProps('/pagina/francisco')).toEqual({
      rota: '/pagina/:slug',
      publico: 'visitante',
    });
  });
});
