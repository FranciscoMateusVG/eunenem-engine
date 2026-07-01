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
import { TweaksProvider } from '@/components/eunenem/TweaksContext';
import type { TweaksState } from '@/lib/mocks/tweaksDefaults';
import { CartProvider } from '@/lib/cart.js';
import { trpc } from '@/lib/trpc';
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
export function PaginaPage({ slug }: { slug: string }) {
  const perfil = trpc.perfil.getPerfilPublicoBySlug.useQuery(
    { slug },
    { staleTime: 60_000, retry: false },
  );

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

  return (
    <TweaksProvider initialState={initialTweaks}>
      <CartProvider slug={slug}>
        <CartDrawerProvider>
          <Navbar slug={slug} />
          <main className="flex-1 pt-16">
            <Hero
              coverUrl={data?.fotoCapaUrl ?? null}
              profileUrl={data?.fotoPerfilUrl ?? null}
              eventDate={eventDate}
            />
            <Story
              historia={data?.historia ?? null}
              fotoHistoria={data?.fotoHistoriaUrl ?? null}
            />
            <Marketplace slug={slug} />
            <HowTo />
            <Messages slug={slug} />
          </main>
          <Footer />
          <CartDrawerMount slug={slug} />
        </CartDrawerProvider>
      </CartProvider>
    </TweaksProvider>
  );
}

// Tiny indirection so the CartDrawer reads from CartDrawerContext (only
// available below the provider) without forcing PaginaPage itself to.
function CartDrawerMount({ slug }: { slug: string }) {
  const drawer = useCartDrawer();
  return <CartDrawer open={drawer.isOpen} onClose={drawer.close} slug={slug} />;
}
