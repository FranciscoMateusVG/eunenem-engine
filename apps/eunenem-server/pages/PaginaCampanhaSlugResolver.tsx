import { CampanhaRotaProvider } from '@/lib/campanha-rota';
import { trpc } from '@/lib/trpc';
import { NotFoundPage } from './NotFoundPage.js';
import { PaginaPage } from './PaginaPage.js';

// aperture-1yx1n Phase B — /pagina/<user-slug>/<campanha-slug> resolution.
//
// Rex's W1a design (aperture-aphk8, frozen §5): pretty campanha slugs are a
// PUBLIC-page-only affordance resolved by ONE query —
// pagina.resolverCampanhaSlug({slug, campanhaSlug}) → {idCampanha} — after
// which everything renders through the EXISTING idCampanha plumbing
// (#343/#353/#357 hooks and inputs, unchanged). /c/<uuid> stays the
// canonical fallback; bare = oldest; painel stays UUID-addressed.
//
// resolveRoute (App.tsx) is a pure sync function, so the async slug→id hop
// lives here: loading → the same minimal spinner PaginaPage uses;
// NOT_FOUND / error → not-found body (same fetch-time convention as
// unknown /c/ ids).

export function PaginaCampanhaSlugResolver({
  slug,
  campanhaSlug,
}: {
  slug: string;
  campanhaSlug: string;
}) {
  // aperture-1yx1n — real inference post-#359 (the shim swap point fired).
  const resolver = trpc.pagina.resolverCampanhaSlug.useQuery(
    { slug, campanhaSlug },
    { staleTime: 60_000, retry: false },
  );

  if (resolver.isLoading) {
    // Same minimal branded placeholder PaginaPage shows while its perfil
    // projection loads — no flash of wrong-campanha data.
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--paper)',
        }}
      >
        <span className="perfil-spinner" aria-hidden="true" />
      </div>
    );
  }

  const idCampanha = resolver.data?.idCampanha;
  if (!idCampanha) {
    return <NotFoundPage pathname={`/pagina/${slug}/${campanhaSlug}`} />;
  }

  return (
    <CampanhaRotaProvider idCampanha={idCampanha}>
      <PaginaPage slug={slug} idCampanha={idCampanha} />
    </CampanhaRotaProvider>
  );
}
