/**
 * aperture-4e1qo — owner-only "Editar lista de presentes" shortcut on the
 * public gift page. Node-env pins: the pure fail-closed href helper, the
 * link's SSR markup/a11y contract, and source-level guards on where the
 * Marketplace renders it. Real click navigation + touch geometry are
 * real-browser evidence (local fixture run recorded on the bead + Izzy).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OwnerEditListaLink } from '../../../apps/eunenem-server/pages/components/eunenem/Marketplace.js';
import {
  OWNER_EDIT_LISTA_LABEL,
  ownerListaEditHref,
} from '../../../apps/eunenem-server/pages/lib/pagina-owner.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react') as {
  createElement: (type: unknown, props: Record<string, unknown>) => unknown;
};
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};
const APP = join(__dirname, '../../../apps/eunenem-server');
const src = (rel: string) => readFileSync(join(APP, rel), 'utf8');

describe('4e1qo ownerListaEditHref — fail-closed, campanha-exact', () => {
  it('owner of the displayed campanha → /painel/<creator slug>/c/<idCampanha>/lista', () => {
    expect(ownerListaEditHref({ isOwner: true, idCampanha: 'camp-2', slug: 'mari' })).toBe(
      '/painel/mari/c/camp-2/lista',
    );
  });

  it('multi-list: the href targets the campanha being displayed, never the bare (oldest) painel', () => {
    const second = ownerListaEditHref({ isOwner: true, idCampanha: 'camp-second', slug: 'mari' });
    expect(second).toBe('/painel/mari/c/camp-second/lista');
    expect(second).not.toBe('/painel/mari/lista');
  });

  it('pretty public route (/pagina/<slug>/<campanha-slug>): href uses the projection slug + resolved id, never the route param', () => {
    // The resolver hands PaginaPage the creator slug + idCampanha; the helper
    // only ever sees the server projection, so a campanha pretty slug in the
    // URL can never leak into the painel href.
    const projection = { isOwner: true, idCampanha: 'camp-second', slug: 'mari' };
    expect(ownerListaEditHref(projection)).toBe('/painel/mari/c/camp-second/lista');
    expect(ownerListaEditHref(projection)).not.toContain('lista-da-helena');
  });

  it('loading / error (no projection) → null', () => {
    expect(ownerListaEditHref(undefined)).toBeNull();
    expect(ownerListaEditHref(null)).toBeNull();
  });

  it('signed-out, guest and other owner (isOwner false/undefined/null) → null', () => {
    expect(ownerListaEditHref({ isOwner: false, idCampanha: 'camp-1', slug: 'mari' })).toBeNull();
    expect(ownerListaEditHref({ idCampanha: 'camp-1', slug: 'mari' })).toBeNull();
    expect(ownerListaEditHref({ isOwner: null, idCampanha: 'camp-1', slug: 'mari' })).toBeNull();
  });

  it('owner but no resolvable campanha or slug → null (never a guessed link)', () => {
    expect(ownerListaEditHref({ isOwner: true, idCampanha: null, slug: 'mari' })).toBeNull();
    expect(ownerListaEditHref({ isOwner: true, idCampanha: '  ', slug: 'mari' })).toBeNull();
    expect(ownerListaEditHref({ isOwner: true, idCampanha: 'camp-1', slug: '' })).toBeNull();
  });
});

describe('4e1qo OwnerEditListaLink — native link, labelled, 44px floor', () => {
  const html = renderToStaticMarkup(
    createElement(OwnerEditListaLink, { href: '/painel/mari/c/camp-2/lista' }),
  );

  it('is a plain anchor with the exact href and the visible label', () => {
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/painel/mari/c/camp-2/lista"');
    expect(html).toContain(OWNER_EDIT_LISTA_LABEL);
    expect(html).toContain('data-testid="owner-edit-lista"');
    expect(html).not.toContain('onclick');
  });

  it('icon is decorative; touch floor and focus ring come from the shared classes', () => {
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('min-height:44px');
    expect(html).toContain('eu-owner-edit-lista');
    const css = src('tailwind.css');
    expect(css).toMatch(/\.eu-owner-edit-lista:focus-visible\s*\{/);
  });
});

describe('4e1qo Marketplace — link only where the prop is set (header + empty state)', () => {
  const mk = src('pages/components/eunenem/Marketplace.tsx');
  const page = src('pages/PaginaPage.tsx');

  it('renders ONE link, in the header (which persists in the empty state), guarded by ownerEditHref', () => {
    expect((mk.match(/\{ownerEditHref && \(/g) ?? []).length).toBe(1);
    expect((mk.match(/<OwnerEditListaLink href=\{ownerEditHref\} \/>/g) ?? []).length).toBe(1);
    const header = mk.slice(mk.indexOf('<header'), mk.indexOf('</header>'));
    expect(header).toContain('<OwnerEditListaLink href={ownerEditHref} />');
    // the header is rendered before the loading/error/empty/grid branch, so it
    // stays on screen in the empty state — no duplicate CTA inside it
    expect(mk.indexOf('</header>')).toBeLessThan(mk.indexOf('gifts.length === 0'));
    expect(mk).toContain('ownerEditHref = null');
  });

  it('PaginaPage derives the href from the server projection only and passes it once', () => {
    expect(page).toContain('const ownerEditHref = ownerListaEditHref(data);');
    expect(page).toContain('<Marketplace slug={slug} ownerEditHref={ownerEditHref} />');
    // never from auth.me / login state
    expect(page).not.toMatch(/auth\.me/);
  });

  it('no cart/checkout hooks are touched by the link (source guard)', () => {
    const link = mk.slice(
      mk.indexOf('export function OwnerEditListaLink'),
      mk.indexOf('export function Marketplace('),
    );
    expect(link).not.toMatch(/useCart|useCartDrawer|GiftCheckoutModal|onAdd|onPick/);
  });
});
