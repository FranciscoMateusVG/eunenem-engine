import { CartDrawer } from '@/components/eunenem/CartDrawer';
import {
  CartDrawerProvider,
  useCartDrawer,
} from '@/components/eunenem/CartDrawerContext';
import { Footer } from '@/components/eunenem/Footer';
import { Hero } from '@/components/eunenem/Hero';
import { HowTo } from '@/components/eunenem/HowTo';
import { Marketplace } from '@/components/eunenem/Marketplace';
import { Messages } from '@/components/eunenem/Messages';
import { Navbar } from '@/components/eunenem/Navbar';
import { Story } from '@/components/eunenem/Story';
import { useTweaks } from '@/components/eunenem/TweaksContext';
import { painelHref } from '@/lib/painelRoutes';
import { TweaksProvider } from '@/components/eunenem/TweaksContext';
import type { TweaksState } from '@/lib/mocks/tweaksDefaults';
import { ownerListaEditHref } from '@/lib/pagina-owner';
import { normalizeHex, triadFor } from '@/lib/palette';
import { sendPageView } from '@/lib/analytics.js';
import { CartProvider } from '@/lib/cart.js';
import { idCampanhaParaPageView, pageViewProps } from '@/lib/rota-canonica.js';
import { trpc } from '@/lib/trpc';
import { useEffect } from 'react';
import { NotFoundPage } from './NotFoundPage.js';

// /pagina/:slug — contributor-facing event page (was /pagina/[slug]/page.tsx
// in eunenem-v2).
//
// aperture-e21v2 — de-hardcoded. ANY syntactically valid slug reaches this
// component (App.tsx resolveRoute regex-matches). Existence + the real
// creator profile are resolved here via trpc.perfil.getPerfilPublicoBySlug
// (R3, PII-safe projection): unknown slug → NotFoundPage; found → the real
// babyName / creatorName / event date seed TweaksProvider so the Hero +
// countdown render that creator's data (no more hardcoded "francisco").
//
// Slug threads down to Marketplace (aperture-3xgch) so the visitor read +
// embedded Stripe checkout can resolve the campanha server-side. Other
// children (Hero, Story, Messages) read display data from TweaksContext.
//
// Plan 0017 / aperture-16flf — CartProvider wraps the whole tree so the
// Marketplace, Navbar, and Drawer all share one cart state (scoped to
// this slug). CartDrawerProvider sits inside it to surface open/close
// for the navbar + add-to-cart triggers. The actual <CartDrawer /> mounts
// at PaginaPage level so it overlays the entire page chrome.
export function PaginaPage({
  slug,
  idCampanha,
}: {
  slug: string;
  /**
   * aperture-h0hom / aperture-1yx1n — specific campanha (from
   * /pagina/:slug/c/:id). Threaded into getPerfilPublicoBySlug so the page
   * header (baby name, date, fotos) reflects THAT campanha's perfil.
   */
  idCampanha?: string;
}) {
  // aperture-1yx1n — idCampanha is a real optional input post-#359 (shim
  // swap point fired; plain inference).
  const preview = typeof window !== "undefined" && window.parent !== window && new URLSearchParams(window.location.search).has("personalizar-preview");
  const perfil = trpc.perfil.getPerfilPublicoBySlug.useQuery(
    idCampanha ? { slug, idCampanha } : { slug },
    { staleTime: 60_000, retry: false },
  );

  // aperture-ppuay — the public GIFT PAGE was the headline untracked surface.
  // Fire the page-view once the perfil resolves to a real page (not NOT_FOUND).
  // aperture-ai8vg — no slug (owner's first name) in props; the opaque
  // campanha id rides instead. On the bare /pagina/:slug the id comes from the
  // SERVER-resolved projection (perfil.data.idCampanha), cross-checked with
  // the route id on /c/:idCampanha — so the per-campanha visitor step works
  // for the common bare URL, not only the explicit one.
  const idCampanhaPageView = idCampanhaParaPageView(idCampanha, perfil.data?.idCampanha);
  useEffect(() => {
    if (perfil.data && !preview) {
      sendPageView(
        'Pagina',
        pageViewProps(
          window.location.pathname,
          idCampanhaPageView ? { id_campanha: idCampanhaPageView } : {},
        ),
      );
    }
  }, [perfil.data, idCampanhaPageView, preview]);
  // Marketplace + Messages need NO prop threading: their hooks
  // (usePaginaListaPresentes / usePaginaMural) self-resolve the route
  // campanha via useCampanhaRota() — the route-level CampanhaRotaProvider
  // (App.tsx pickPage, PR #353) covers this whole tree.

  // Unknown slug → honest not-found (the public projection threw NOT_FOUND).
  if (perfil.error?.data?.code === 'NOT_FOUND') {
    return <NotFoundPage pathname={`/pagina/${slug}`} />;
  }

  // First paint while the projection loads — minimal branded placeholder so
  // we don't flash default ("Francisco") data before the real name arrives.
  if (perfil.isLoading) {
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

  if (preview && perfil.error) {
    return <div role="alert" style={{ padding: 24 }}>Não consegui carregar a prévia. <button type="button" onClick={() => void perfil.refetch()}>Tentar novamente</button></div>;
  }

  // Found (or a transient non-404 error → render with defaults, children
  // handle their own loading). Seed only the fields the public projection
  // actually carries; the rest fall back to TweaksProvider defaults.
  const data = perfil.data;
  const initialTweaks: Partial<TweaksState> = {};
  if (data?.nomeBebe) initialTweaks.babyName = data.nomeBebe;
  if (data?.genero) initialTweaks.genero = data.genero;
  if (data?.creatorName) initialTweaks.parents = data.creatorName;
  // aperture-3ic62 — the REAL event date (ISO YYYY-MM-DD) or null when the
  // creator never set one. We thread it explicitly to the Hero instead of
  // relying on tweaks.targetDate: when dataEvento is null, targetDate would
  // silently fall back to the shared TWEAKS_DEFAULTS demo date
  // ("2026-06-15") and render a fake "chegada em 0 dias" countdown. The Hero
  // hides the countdown entirely when this is null. We still seed
  // tweaks.targetDate when a real date exists (other consumers may read it).
  const eventDate = data?.dataEvento ? data.dataEvento.slice(0, 10) : null;
  if (eventDate) initialTweaks.targetDate = eventDate;
  if (data?.papais) initialTweaks.parents = data.papais;
  // aperture-whxzg — one derivation path for the primary triad (presets keep
  // their hand-tuned deep/soft; any other valid hex gets a derived pair).
  const seedPrimary = normalizeHex(data?.corPrimaria);
  if (seedPrimary) Object.assign(initialTweaks, triadFor(seedPrimary));
  const seedAccent = normalizeHex(data?.corAcento);
  if (seedAccent) initialTweaks.accent = seedAccent;
  // aperture-whxzg — seed the story + photo previews from the public
  // projection so the owner editor's baseline equals what guests see.
  initialTweaks.historia = data?.historia ?? "";
  initialTweaks.fotoCapaUrl = data?.fotoCapaUrl ?? null;
  initialTweaks.fotoPerfilUrl = data?.fotoPerfilUrl ?? null;
  initialTweaks.fotoHistoriaUrl = data?.fotoHistoriaUrl ?? null;
  const isOwner = data?.isOwner ?? false;
  // aperture-4e1qo — owner shortcut to edit THIS campanha's gift list
  // (fail-closed: null unless the server says owner + id + creator slug).
  const ownerEditHref = preview ? null : ownerListaEditHref(data);

  return (
    <TweaksProvider initialState={initialTweaks}>
      {preview && <CustomizationPreviewBridge />}
      <div inert={preview || undefined} style={{ display: "contents" }}>
      <CartProvider slug={slug}>
        <CartDrawerProvider>
          <Navbar slug={slug} />
          <main className="flex-1 pt-16">
            <Hero
              coverUrl={data?.fotoCapaUrl ?? null}
              profileUrl={data?.fotoPerfilUrl ?? null}
              eventDate={eventDate}
              tipoEvento={data?.tipoEvento ?? null}
              editable={false}
            />
            <Story
              historia={data?.historia ?? null}
              fotoHistoria={data?.fotoHistoriaUrl ?? null}
              editable={false}
            />
            <Marketplace slug={slug} ownerEditHref={ownerEditHref} />
            <HowTo />
            <Messages slug={slug} />
          </main>
          <Footer />
          {isOwner && !preview && data?.idCampanha && <CustomizationShortcut slug={data.slug} idCampanha={data.idCampanha} />}
          <CartDrawerMount slug={slug} />
        </CartDrawerProvider>
      </CartProvider>
      </div>
    </TweaksProvider>
  );
}

// Tiny indirection so the CartDrawer reads from CartDrawerContext (only
// available below the provider) without forcing PaginaPage itself to.
function CartDrawerMount({ slug }: { slug: string }) {
  const drawer = useCartDrawer();
  return <CartDrawer open={drawer.isOpen} onClose={drawer.close} slug={slug} />;
}

function CustomizationShortcut({ slug, idCampanha }: { slug: string; idCampanha: string }) {
  const drawer = useCartDrawer();
  if (drawer.purchaseOverlayVisible) return null;
  return <a className="perfil-btn perfil-btn-primary" style={{ position: "fixed", bottom: 24, right: 24, zIndex: 30 }} href={painelHref(slug, "personalizar", idCampanha)}>Personalizar página</a>;
}

// The public component tree is unchanged. Only draft presentation fields from
// the same-origin parent are accepted; no mutations or checkout are exposed.
function CustomizationPreviewBridge() {
  const { setTweaks } = useTweaks();
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== "eunenem-preview") return;
      const draft = event.data.draft;
      if (!draft || typeof draft !== "object") return;
      const patch: Partial<TweaksState> = {};
      const primary = normalizeHex(draft.corPrimaria);
      const accent = normalizeHex(draft.corAcento);
      if (primary) Object.assign(patch, triadFor(primary));
      if (accent) patch.accent = accent;
      for (const field of ["fotoPerfilUrl", "fotoCapaUrl", "fotoHistoriaUrl"] as const) {
        const value = draft[field];
        if (value === null || (typeof value === "string" && /^https?:\/\//.test(value))) patch[field] = value;
      }
      setTweaks(patch);
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "eunenem-preview-ready" }, window.location.origin);
    return () => window.removeEventListener("message", receive);
  }, [setTweaks]);
  return null;
}
