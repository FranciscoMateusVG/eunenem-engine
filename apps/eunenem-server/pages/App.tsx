import { Toaster } from 'sonner';
import { NotFoundPage } from './NotFoundPage.js';
import { PaginaPage } from './PaginaPage.js';
import { PainelPage } from './PainelPage.js';
import { PainelSectionPage } from './PainelSectionPage.js';
import { isPainelSection, type PainelSection } from './lib/painelRoutes.js';

// Mock-first: the only recognised creator slug is "helena" (the public
// contributor page uses "francisco"). A later auth epic resolves the
// signed-in user's real slug.
const PAINEL_SLUG = 'helena';

// Route map (single source of truth, used by both server.tsx and client.tsx).
// Server uses this to decide HTTP status (404 vs 200) before rendering.
// Client uses it to render the right component during hydration.
//
// Painel convention (aperture-vv3i): /painel/:slug is the dashboard;
// /painel/:slug/:section is an authenticated sub-page. Valid sections live in
// lib/painelRoutes.ts — an unknown sub-section 404s honestly.
export function resolveRoute(pathname: string):
  | { kind: 'pagina'; slug: string }
  | { kind: 'painel'; slug: string }
  | { kind: 'painel-section'; slug: string; section: PainelSection }
  | { kind: 'not-found' } {
  const paginaMatch = pathname.match(/^\/pagina\/([^/]+)\/?$/);
  if (paginaMatch && paginaMatch[1] === 'francisco') {
    return { kind: 'pagina', slug: paginaMatch[1] };
  }
  const painelMatch = pathname.match(/^\/painel\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (painelMatch && painelMatch[1] === PAINEL_SLUG) {
    const slug = painelMatch[1];
    const section = painelMatch[2];
    if (!section) {
      return { kind: 'painel', slug };
    }
    if (isPainelSection(section)) {
      return { kind: 'painel-section', slug, section };
    }
    // Known slug, unknown sub-section → honest 404.
    return { kind: 'not-found' };
  }
  return { kind: 'not-found' };
}

export function App({ pathname }: { pathname: string }) {
  const route = resolveRoute(pathname);
  return (
    <>
      {pickPage(route, pathname)}
      <Toaster
        position="bottom-center"
        theme="light"
        richColors
        toastOptions={{
          style: { fontFamily: 'var(--font-dm-sans), system-ui, sans-serif' },
        }}
      />
    </>
  );
}

function pickPage(route: ReturnType<typeof resolveRoute>, pathname: string) {
  if (route.kind === 'pagina') return <PaginaPage slug={route.slug} />;
  if (route.kind === 'painel') return <PainelPage slug={route.slug} />;
  if (route.kind === 'painel-section')
    return <PainelSectionPage slug={route.slug} section={route.section} />;
  return <NotFoundPage pathname={pathname} />;
}
