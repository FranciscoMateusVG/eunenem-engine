import { Toaster } from 'sonner';
import { AuthDemoPage } from './AuthDemoPage.js';
import { AuthModalProvider } from './components/eunenem/auth/AuthModalProvider.js';
import { LandingPage } from './LandingPage.js';
import { NotFoundPage } from './NotFoundPage.js';
import { PaginaPage } from './PaginaPage.js';
import { PaginaSucessoPage } from './PaginaSucessoPage.js';
import { PainelPage } from './PainelPage.js';
import { PainelSectionPage } from './PainelSectionPage.js';
import { TrpcSmokePage } from './TrpcSmokePage.js';
import { TrpcProvider } from './lib/TrpcProvider.js';
import { isPainelSection, type PainelSection } from './lib/painelRoutes.js';

// Slug shape — matches the SlugUsuario VO (src/domain/usuario/value-objects/
// slug-usuario.ts). Kept duplicated here so resolveRoute remains a pure
// no-engine-dep function (App.tsx is shared SSR + client). The VO is the
// source of truth; if it ever changes shape, update this regex too.
const SLUG_REGEX = /^[a-z][a-z0-9-]{2,29}$/;

// Route map (single source of truth, used by both server.tsx and client.tsx).
// Server uses this to decide HTTP status (404 vs 200) before rendering.
// Client uses it to render the right component during hydration.
//
// Painel convention (aperture-vv3i): /painel/:slug is the dashboard;
// /painel/:slug/:section is an authenticated sub-page. Valid sections live in
// lib/painelRoutes.ts — an unknown sub-section 404s honestly.
//
// Slug shape (aperture-khbow): /painel/:slug now accepts ANY syntactically
// valid slug (regex-matched). The router doesn't know if the slug owner
// actually exists — that's an SSR-time DB lookup in server.tsx, which
// flips the status to 404 when findUsuarioBySlug returns undefined.
// Pure-client navigation (e.g. /painel/unknown typed in a fresh tab without
// SSR) will still hit the SSR catch-all and get its 404 honestly.
export function resolveRoute(pathname: string):
  | { kind: 'landing' }
  | { kind: 'pagina'; slug: string }
  | { kind: 'pagina-sucesso'; slug: string }
  | { kind: 'painel'; slug: string }
  | { kind: 'painel-section'; slug: string; section: PainelSection }
  | { kind: 'trpc-smoke' }
  | { kind: 'auth-demo' }
  | { kind: 'not-found' } {
  // Marketing landing page (aperture-q1j2) — exact "/" only.
  if (pathname === '/') {
    return { kind: 'landing' };
  }
  // tRPC smoke test (aperture-kungg) — dev-only verification surface.
  if (pathname === '/trpc-smoke') {
    return { kind: 'trpc-smoke' };
  }
  // Auth modal demo (aperture-ubpnl) — dev-only verification surface for the
  // AuthModalShell. Unlisted in nav; reachable only by typing the URL.
  if (pathname === '/auth-demo') {
    return { kind: 'auth-demo' };
  }
  // /pagina/<slug>/sucesso — post-Stripe-checkout thank-you page
  // (aperture-xh4jk). Matched BEFORE the bare /pagina/<slug> rule so the
  // sub-path takes precedence. sessionId travels as a query param and is
  // read client-side from window.location (server can't see it through
  // pathname alone).
  const sucessoMatch = pathname.match(/^\/pagina\/([^/]+)\/sucesso\/?$/);
  if (sucessoMatch && sucessoMatch[1] === 'francisco') {
    return { kind: 'pagina-sucesso', slug: sucessoMatch[1] };
  }
  const paginaMatch = pathname.match(/^\/pagina\/([^/]+)\/?$/);
  if (paginaMatch && paginaMatch[1] === 'francisco') {
    return { kind: 'pagina', slug: paginaMatch[1] };
  }
  const painelMatch = pathname.match(/^\/painel\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (painelMatch && painelMatch[1] && SLUG_REGEX.test(painelMatch[1])) {
    const slug = painelMatch[1];
    const section = painelMatch[2];
    if (!section) {
      return { kind: 'painel', slug };
    }
    if (isPainelSection(section)) {
      return { kind: 'painel-section', slug, section };
    }
    // Known-shape slug, unknown sub-section → honest 404.
    return { kind: 'not-found' };
  }
  return { kind: 'not-found' };
}

export function App({ pathname }: { pathname: string }) {
  const route = resolveRoute(pathname);
  // TrpcProvider is mounted at the root so every route can call
  // `trpc.X.useQuery()` (aperture-7337j). Same tree on server + client
  // → no hydration mismatch.
  return (
    <TrpcProvider>
      {/* AuthModalProvider (aperture-nop8l) — singleton modal mounted at the
       *  tree root so any landing CTA or painel control can summon it via
       *  `useAuthModal()`. Renders the AuthModalShell itself when open. */}
      <AuthModalProvider>
        {pickPage(route, pathname)}
        <Toaster
          position="bottom-center"
          theme="light"
          richColors
          toastOptions={{
            style: { fontFamily: 'var(--font-dm-sans), system-ui, sans-serif' },
          }}
        />
      </AuthModalProvider>
    </TrpcProvider>
  );
}

function pickPage(route: ReturnType<typeof resolveRoute>, pathname: string) {
  if (route.kind === 'landing') return <LandingPage />;
  if (route.kind === 'pagina') return <PaginaPage slug={route.slug} />;
  if (route.kind === 'pagina-sucesso') return <PaginaSucessoPage slug={route.slug} />;
  if (route.kind === 'painel') return <PainelPage slug={route.slug} />;
  if (route.kind === 'painel-section')
    return <PainelSectionPage slug={route.slug} section={route.section} />;
  if (route.kind === 'trpc-smoke') return <TrpcSmokePage />;
  if (route.kind === 'auth-demo') return <AuthDemoPage />;
  return <NotFoundPage pathname={pathname} />;
}
