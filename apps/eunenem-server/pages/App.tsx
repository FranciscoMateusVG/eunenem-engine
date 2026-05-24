import { Toaster } from 'sonner';
import { NotFoundPage } from './NotFoundPage.js';
import { PaginaPage } from './PaginaPage.js';
import { PainelPage } from './PainelPage.js';

// Route map (single source of truth, used by both server.tsx and client.tsx).
// Server uses this to decide HTTP status (404 vs 200) before rendering.
// Client uses it to render the right component during hydration.
export function resolveRoute(pathname: string):
  | { kind: 'pagina'; slug: string }
  | { kind: 'painel'; slug: string }
  | { kind: 'not-found' } {
  const paginaMatch = pathname.match(/^\/pagina\/([^/]+)\/?$/);
  if (paginaMatch && paginaMatch[1] === 'francisco') {
    return { kind: 'pagina', slug: paginaMatch[1] };
  }
  const painelMatch = pathname.match(/^\/painel\/([^/]+)\/?$/);
  if (painelMatch && painelMatch[1] === 'helena') {
    return { kind: 'painel', slug: painelMatch[1] };
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
  return <NotFoundPage pathname={pathname} />;
}
