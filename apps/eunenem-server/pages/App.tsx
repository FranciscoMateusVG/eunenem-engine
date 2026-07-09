import { Toaster } from 'sonner';
import { AdminCampanhaPage } from './AdminCampanhaPage.js';
import { AdminContribuicaoPage } from './AdminContribuicaoPage.js';
import { AdminPage } from './AdminPage.js';
import { AdminPagamentoPage } from './AdminPagamentoPage.js';
import { AdminRepasseDetailPage } from './AdminRepasseDetailPage.js';
import { AdminRepassesPage } from './AdminRepassesPage.js';
import { AdminUsuarioPage } from './AdminUsuarioPage.js';
import { AuthDemoPage } from './AuthDemoPage.js';
import { ConfirmarPresencaPage } from './ConfirmarPresencaPage.js';
import { FaqPage } from './FaqPage.js';
import { AuthModalProvider } from './components/eunenem/auth/AuthModalProvider.js';
import { CampanhasPage } from './CampanhasPage.js';
import { LandingPage } from './LandingPage.js';
import { NotFoundPage } from './NotFoundPage.js';
import { PainelConvitePreviewPage } from './PainelConvitePreviewPage.js';
import { PaginaCampanhaSlugResolver } from './PaginaCampanhaSlugResolver.js';
import { PaginaPage } from './PaginaPage.js';
import { PaginaSucessoPage } from './PaginaSucessoPage.js';
import { PainelPage } from './PainelPage.js';
import { PainelSectionPage } from './PainelSectionPage.js';
import { TermosDeUsoPage } from './TermosDeUsoPage.js';
import { TrpcSmokePage } from './TrpcSmokePage.js';
import { TrpcProvider } from './lib/TrpcProvider.js';
import { CampanhaRotaProvider } from './lib/campanha-rota.js';
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
  | { kind: 'campanhas' }
  | { kind: 'pagina'; slug: string; idCampanha?: string; campanhaSlug?: string }
  | { kind: 'pagina-sucesso'; slug: string }
  | { kind: 'confirmar-presenca'; slug: string; idConvidado: string }
  | { kind: 'painel'; slug: string; idCampanha?: string }
  | { kind: 'painel-convite-preview'; slug: string; idCampanha?: string }
  | { kind: 'painel-section'; slug: string; section: PainelSection; idCampanha?: string }
  | { kind: 'termos-de-uso' }
  | { kind: 'trpc-smoke' }
  | { kind: 'auth-demo' }
  | { kind: 'faq' }
  | { kind: 'admin' }
  | { kind: 'admin-usuario'; idConta: string }
  | { kind: 'admin-campanha'; idCampanha: string }
  | { kind: 'admin-contribuicao'; idContribuicao: string }
  | { kind: 'admin-pagamento'; idPagamento: string }
  | { kind: 'admin-repasses' }
  | { kind: 'admin-repasse-detail'; idRepasse: string }
  | { kind: 'not-found' } {
  // Marketing landing page (aperture-q1j2) — exact "/" only.
  if (pathname === '/') {
    return { kind: 'landing' };
  }
  if (pathname === '/termos-de-uso' || pathname === '/termos-de-uso/') {
    return { kind: 'termos-de-uso' };
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
  // Perguntas Frequentes (aperture-sgjnn) — public FAQ page, linked from the
  // footer. Exact "/faq" only.
  if (pathname === '/faq') {
    return { kind: 'faq' };
  }
  // Multicampanha bridge (aperture-g7l09, epic aperture-7hm2g) — the mixed
  // 1.0/2.0 campaign grid. Post-login default lands here for the POC (see
  // AuthModalProvider + useOauthReturnRedirect). Authenticated surface: the
  // page itself bounces anonymous visitors back to "/" client-side; the
  // route resolves 200 unconditionally (same pattern as /painel — content,
  // not status, reflects auth).
  if (pathname === '/campanhas' || pathname === '/campanhas/') {
    return { kind: 'campanhas' };
  }
  // Operator admin — DDD-trace drill-down (aperture-rsidz.1, W0). No auth
  // gate per operator directive. Sub-routes for the drills follow below
  // (rsidz.2+); they MUST be matched BEFORE the bare /admin so the more
  // specific match wins.
  //
  // /admin/usuario/<idConta> (rsidz.2, W1) — user detail page.
  // idConta is a free-shape string here; the tRPC fetch returns null
  // for unknown ids and the page renders a not-found body. We don't
  // pre-validate the UUID shape because the engine's id format may
  // evolve and the page handles the empty result honestly.
  const adminUsuarioMatch = pathname.match(/^\/admin\/usuario\/([^/]+)\/?$/);
  if (adminUsuarioMatch && adminUsuarioMatch[1]) {
    return { kind: 'admin-usuario', idConta: adminUsuarioMatch[1] };
  }
  // /admin/campanha/<idCampanha> (rsidz.3, W2) — campanha detail page.
  // Matched BEFORE the bare /admin rule for the same specificity reason
  // as /admin/usuario above. idCampanha is a free-shape string here;
  // the tRPC fetch returns null for unknown ids and the page renders a
  // not-found body.
  const adminCampanhaMatch = pathname.match(/^\/admin\/campanha\/([^/]+)\/?$/);
  if (adminCampanhaMatch && adminCampanhaMatch[1]) {
    return { kind: 'admin-campanha', idCampanha: adminCampanhaMatch[1] };
  }
  // /admin/contribuicao/<idContribuicao> (rsidz.4, W3) — contribuição detail
  // page (triple-BC layout). Matched BEFORE the bare /admin rule for the
  // same specificity reason as /admin/usuario + /admin/campanha above.
  // idContribuicao is a free-shape string here; the tRPC fetch returns
  // null for unknown ids and ArrecadacaoSection renders a not-found body.
  const adminContribuicaoMatch = pathname.match(
    /^\/admin\/contribuicao\/([^/]+)\/?$/,
  );
  if (adminContribuicaoMatch && adminContribuicaoMatch[1]) {
    return {
      kind: 'admin-contribuicao',
      idContribuicao: adminContribuicaoMatch[1],
    };
  }
  // /admin/pagamento/<idPagamento> (Plan 0017 / aperture-gf2t5) — pagamento
  // detail page. The pagamento-first reshape promotes Pagamento to a
  // first-class admin drill target (previously you could only reach a
  // pagamento by drilling INTO a contribuição first; under the new ontology
  // Pagamento IS the transaction aggregate root). Matched before the bare
  // /admin rule. idPagamento is a free-shape string here; the tRPC
  // findById throws NOT_FOUND for unknown ids and the page renders a
  // not-found body (HTTP stays 200, same pattern as the other drill pages).
  const adminPagamentoMatch = pathname.match(
    /^\/admin\/pagamento\/([^/]+)\/?$/,
  );
  if (adminPagamentoMatch && adminPagamentoMatch[1]) {
    return {
      kind: 'admin-pagamento',
      idPagamento: adminPagamentoMatch[1],
    };
  }
  // /admin/repasses/<idRepasse> (plan q2d4b Track 3, aperture-vi0hy) —
  // single-repasse approval flow. Matched BEFORE the bare /admin/repasses
  // rule so the more specific match wins. idRepasse is a free-shape string
  // here; the tRPC fetch (stub today) returns null for unknown ids and
  // AdminRepasseDetailPage renders a not-found body.
  const adminRepasseDetailMatch = pathname.match(
    /^\/admin\/repasses\/([^/]+)\/?$/,
  );
  if (adminRepasseDetailMatch && adminRepasseDetailMatch[1]) {
    return {
      kind: 'admin-repasse-detail',
      idRepasse: adminRepasseDetailMatch[1],
    };
  }
  if (pathname === '/admin/repasses' || pathname === '/admin/repasses/') {
    return { kind: 'admin-repasses' };
  }
  if (pathname === '/admin' || pathname === '/admin/') {
    return { kind: 'admin' };
  }
  // /pagina/<slug>/sucesso — post-Stripe-checkout thank-you page
  // (aperture-xh4jk). Matched BEFORE the bare /pagina/<slug> rule so the
  // sub-path takes precedence. sessionId travels as a query param and is
  // read client-side from window.location (server can't see it through
  // pathname alone).
  // aperture-e21v2 — de-hardcoded. Any syntactically valid slug routes to the
  // public page; existence is resolved at render time via
  // trpc.perfil.getPerfilPublicoBySlug (unknown slug → not-found UI). Mirrors
  // the painel rule below (regex-match; the pure router doesn't know owners).
  const sucessoMatch = pathname.match(/^\/pagina\/([^/]+)\/sucesso\/?$/);
  if (sucessoMatch && sucessoMatch[1] && SLUG_REGEX.test(sucessoMatch[1])) {
    return { kind: 'pagina-sucesso', slug: sucessoMatch[1] };
  }
  // /pagina/<slug>/c/<idCampanha> (aperture-h0hom, bvz0p Phase 1) — the
  // public page of a SPECIFIC campanha. Matched BEFORE the bare rule; the
  // 'c' segment marker keeps it out of any future sub-path namespace.
  // idCampanha is free-shape (UUID today): unknown/unowned ids resolve to
  // a not-found body at fetch time, same convention as the admin drills.
  const paginaCampanhaMatch = pathname.match(/^\/pagina\/([^/]+)\/c\/([^/]+)\/?$/);
  if (
    paginaCampanhaMatch?.[1] &&
    paginaCampanhaMatch[2] &&
    SLUG_REGEX.test(paginaCampanhaMatch[1])
  ) {
    return {
      kind: 'pagina',
      slug: paginaCampanhaMatch[1],
      idCampanha: paginaCampanhaMatch[2],
    };
  }
  // /pagina/<user-slug>/<campanha-slug> (aperture-1yx1n Phase B, W1a contract
  // §5) — the PRETTY per-campanha public URL. Matched AFTER the /sucesso and
  // /c/ rules, so those two reserved second segments can never be read as a
  // campanha slug ('c' is additionally impossible: the slug regex requires
  // ≥3 chars). The campanha-slug → idCampanha resolution is ASYNC
  // (pagina.resolverCampanhaSlug, ONE call) and happens at render time in
  // PaginaCampanhaSlugResolver — resolveRoute stays pure. Unknown
  // campanha-slug → not-found body at fetch time, same convention as /c/.
  const paginaCampanhaSlugMatch = pathname.match(/^\/pagina\/([^/]+)\/([^/]+)\/?$/);
  if (
    paginaCampanhaSlugMatch?.[1] &&
    paginaCampanhaSlugMatch[2] &&
    SLUG_REGEX.test(paginaCampanhaSlugMatch[1]) &&
    SLUG_REGEX.test(paginaCampanhaSlugMatch[2])
  ) {
    return {
      kind: 'pagina',
      slug: paginaCampanhaSlugMatch[1],
      campanhaSlug: paginaCampanhaSlugMatch[2],
    };
  }
  const paginaMatch = pathname.match(/^\/pagina\/([^/]+)\/?$/);
  if (paginaMatch && paginaMatch[1] && SLUG_REGEX.test(paginaMatch[1])) {
    return { kind: 'pagina', slug: paginaMatch[1] };
  }
  // /<slug>/confirmar-presenca/<idConvidado> — public RSVP page a guest opens
  // from a WhatsApp link (aperture-confirmar-presenca). Root-level slug (not
  // nested under /pagina/), matched here alongside the other slug-based
  // routes before the /painel/* rules below. Existence of BOTH the slug and
  // the convidadoId is resolved client-side via tRPC (unknown → not-found
  // UI) — same "pure regex router doesn't know owners" convention as
  // /pagina/:slug and /painel/:slug.
  const confirmarPresencaMatch = pathname.match(
    /^\/([^/]+)\/confirmar-presenca\/([^/]+)\/?$/,
  );
  if (
    confirmarPresencaMatch &&
    confirmarPresencaMatch[1] &&
    confirmarPresencaMatch[2] &&
    SLUG_REGEX.test(confirmarPresencaMatch[1])
  ) {
    return {
      kind: 'confirmar-presenca',
      slug: confirmarPresencaMatch[1],
      idConvidado: confirmarPresencaMatch[2],
    };
  }
  const painelConvitePreviewMatch = pathname.match(/^\/painel\/([^/]+)\/convite\/preview\/?$/);
  if (
    painelConvitePreviewMatch &&
    painelConvitePreviewMatch[1] &&
    SLUG_REGEX.test(painelConvitePreviewMatch[1])
  ) {
    return { kind: 'painel-convite-preview', slug: painelConvitePreviewMatch[1] };
  }
  // /painel/<slug>/c/<idCampanha>/convite/preview (aperture-z6vks) — the
  // per-campanha convite preview. The general /c/ matcher below only takes
  // ONE trailing segment, so the two-segment preview path needs its own
  // rule, matched BEFORE it.
  const painelCampanhaConvitePreviewMatch = pathname.match(
    /^\/painel\/([^/]+)\/c\/([^/]+)\/convite\/preview\/?$/,
  );
  if (
    painelCampanhaConvitePreviewMatch?.[1] &&
    painelCampanhaConvitePreviewMatch[2] &&
    SLUG_REGEX.test(painelCampanhaConvitePreviewMatch[1])
  ) {
    return {
      kind: 'painel-convite-preview',
      slug: painelCampanhaConvitePreviewMatch[1],
      idCampanha: painelCampanhaConvitePreviewMatch[2],
    };
  }

  // /painel/<slug>/c/<idCampanha>(/<section>) (aperture-h0hom, bvz0p
  // Phase 1) — a SPECIFIC campanha's painel. Matched BEFORE the bare rule;
  // bare /painel/<slug> keeps meaning the oldest campanha (back-compat).
  const painelCampanhaMatch = pathname.match(
    /^\/painel\/([^/]+)\/c\/([^/]+)(?:\/([^/]+))?\/?$/,
  );
  if (
    painelCampanhaMatch?.[1] &&
    painelCampanhaMatch[2] &&
    SLUG_REGEX.test(painelCampanhaMatch[1])
  ) {
    const slug = painelCampanhaMatch[1];
    const idCampanha = painelCampanhaMatch[2];
    const section = painelCampanhaMatch[3];
    if (!section) {
      return { kind: 'painel', slug, idCampanha };
    }
    if (isPainelSection(section)) {
      return { kind: 'painel-section', slug, section, idCampanha };
    }
    return { kind: 'not-found' };
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
  if (route.kind === 'campanhas') return <CampanhasPage />;
  if (route.kind === 'termos-de-uso') return <TermosDeUsoPage />;
  // aperture-z6vks — CampanhaRotaProvider mounts at ROUTE level for every
  // campanha-addressable page. Hooks that run in the PAGE's own body (e.g.
  // useContribuicaoList in PainelPage) sit ABOVE the PainelLayout-mounted
  // provider, so a layout-level mount alone leaves them reading undefined —
  // the root cause of the "painel shows the default campanha" bug class.
  // PainelLayout keeps its own (same-value) provider; nesting is harmless.
  if (route.kind === 'pagina') {
    // aperture-1yx1n Phase B — pretty campanha-slug URLs resolve async
    // (ONE resolverCampanhaSlug call) then feed the SAME provider+page.
    if (route.campanhaSlug)
      return (
        <PaginaCampanhaSlugResolver
          slug={route.slug}
          campanhaSlug={route.campanhaSlug}
        />
      );
    return (
      <CampanhaRotaProvider idCampanha={route.idCampanha}>
        <PaginaPage slug={route.slug} idCampanha={route.idCampanha} />
      </CampanhaRotaProvider>
    );
  }
  if (route.kind === 'pagina-sucesso') return <PaginaSucessoPage slug={route.slug} />;
  if (route.kind === 'confirmar-presenca')
    return <ConfirmarPresencaPage slug={route.slug} idConvidado={route.idConvidado} />;
  if (route.kind === 'painel')
    return (
      <CampanhaRotaProvider idCampanha={route.idCampanha}>
        <PainelPage slug={route.slug} idCampanha={route.idCampanha} />
      </CampanhaRotaProvider>
    );
  if (route.kind === 'painel-convite-preview')
    return (
      <CampanhaRotaProvider idCampanha={route.idCampanha}>
        <PainelConvitePreviewPage slug={route.slug} />
      </CampanhaRotaProvider>
    );
  if (route.kind === 'painel-section')
    return (
      <CampanhaRotaProvider idCampanha={route.idCampanha}>
        <PainelSectionPage
          slug={route.slug}
          section={route.section}
          idCampanha={route.idCampanha}
        />
      </CampanhaRotaProvider>
    );
  if (route.kind === 'trpc-smoke') return <TrpcSmokePage />;
  if (route.kind === 'auth-demo') return <AuthDemoPage />;
  if (route.kind === 'faq') return <FaqPage />;
  if (route.kind === 'admin') return <AdminPage />;
  if (route.kind === 'admin-usuario')
    return <AdminUsuarioPage idConta={route.idConta} />;
  if (route.kind === 'admin-campanha')
    return <AdminCampanhaPage idCampanha={route.idCampanha} />;
  if (route.kind === 'admin-contribuicao')
    return <AdminContribuicaoPage idContribuicao={route.idContribuicao} />;
  if (route.kind === 'admin-pagamento')
    return <AdminPagamentoPage idPagamento={route.idPagamento} />;
  if (route.kind === 'admin-repasses') return <AdminRepassesPage />;
  if (route.kind === 'admin-repasse-detail')
    return <AdminRepasseDetailPage idRepasse={route.idRepasse} />;
  return <NotFoundPage pathname={pathname} />;
}
