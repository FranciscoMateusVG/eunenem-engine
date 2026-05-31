import { Footer } from '@/components/eunenem/Footer';
import { Hero } from '@/components/eunenem/Hero';
import { HowTo } from '@/components/eunenem/HowTo';
import { Marketplace } from '@/components/eunenem/Marketplace';
import { Messages } from '@/components/eunenem/Messages';
import { MuralProvider } from '@/components/eunenem/MuralContext';
import { Navbar } from '@/components/eunenem/Navbar';
import { Story } from '@/components/eunenem/Story';
import { TweaksPanel } from '@/components/eunenem/TweaksPanel';
import { TweaksProvider } from '@/components/eunenem/TweaksContext';

// /pagina/:slug — contributor-facing event page (was /pagina/[slug]/page.tsx
// in eunenem-v2). v1 only recognises the "francisco" slug; any other slug
// 404s at the App.tsx router level (server returns 404 status; this
// component is never rendered for unknown slugs).
//
// Slug threads down to Marketplace (aperture-3xgch) so the visitor read +
// embedded Stripe checkout can resolve the campanha server-side. Other
// children (Hero, Story, Messages) still don't need it.
export function PaginaPage({ slug }: { slug: string }) {
  return (
    <TweaksProvider>
      <MuralProvider>
        <Navbar />
        <main className="flex-1 pt-16">
          <Hero />
          <Story />
          <Marketplace slug={slug} />
          <HowTo />
          <Messages />
        </main>
        <Footer />
        <TweaksPanel />
      </MuralProvider>
    </TweaksProvider>
  );
}
