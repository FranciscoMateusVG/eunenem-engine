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
import { CartProvider } from '@/lib/cart.js';

// /pagina/:slug — contributor-facing event page (was /pagina/[slug]/page.tsx
// in eunenem-v2). v1 only recognises the "francisco" slug; any other slug
// 404s at the App.tsx router level (server returns 404 status; this
// component is never rendered for unknown slugs).
//
// Slug threads down to Marketplace (aperture-3xgch) so the visitor read +
// embedded Stripe checkout can resolve the campanha server-side. Other
// children (Hero, Story, Messages) still don't need it.
//
// Plan 0017 / aperture-16flf — CartProvider wraps the whole tree so the
// Marketplace, Navbar, and Drawer all share one cart state (scoped to
// this slug). CartDrawerProvider sits inside it to surface open/close
// for the navbar + add-to-cart triggers. The actual <CartDrawer /> mounts
// at PaginaPage level so it overlays the entire page chrome.
export function PaginaPage({ slug }: { slug: string }) {
  return (
    <TweaksProvider>
      <CartProvider slug={slug}>
        <CartDrawerProvider>
          <Navbar />
          <main className="flex-1 pt-16">
            <Hero />
            <Story />
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
