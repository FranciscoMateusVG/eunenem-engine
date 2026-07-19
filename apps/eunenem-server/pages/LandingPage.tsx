import { useEffect } from 'react';
import { useOauthReturnRedirect } from '@/lib/useOauthReturnRedirect';
import { sendPageView } from '@/lib/analytics';
import { Calculadora } from '@/components/eunenem/landing/Calculadora';
import { ChaRifa } from '@/components/eunenem/landing/ChaRifa';
import { CTAFinal } from '@/components/eunenem/landing/CTAFinal';
import { Differential } from '@/components/eunenem/landing/Differential';
import { Footer } from '@/components/eunenem/Footer';
import { Hero } from '@/components/eunenem/landing/Hero';
import { HowItWorks } from '@/components/eunenem/landing/HowItWorks';
import { Invites } from '@/components/eunenem/landing/Invites';
import { Navbar } from '@/components/eunenem/landing/Navbar';
import { Taxas } from '@/components/eunenem/landing/Taxas';
import { Testimonials } from '@/components/eunenem/landing/Testimonials';

// aperture-q1j2 → aperture-h4d7v (v2 rebuild) — marketing landing page
// served at "/". Mock-first, no backend/auth: a pure composition of
// static section components.
//
// aperture-h66q3 — v2 composition wiring:
//   - REMOVED: Stats, TestimonialsHighlight, MediaBar, Showcase (component
//     files deleted from landing/ in this same PR — they're dead code in v2)
//   - ADDED: Calculadora (aperture-5mgiw, §05 — 2-slider income calc),
//     Taxas (aperture-cvhlm, §06 — payout-methods grid, not fees-comparison),
//     ChaRifa (aperture-397x0, §09 — pure-CSS raffle-ticket teaser)
//   - REWRITTEN in sibling PRs: Hero (aperture-ospu7, §01), HowItWorks
//     (aperture-b8yn3, §03), Differential (aperture-hsm41, §04)
//   - Section order matches data-screen-label ordering in
//     extracted/EuNenem Landing v2.html: Navbar → 01 Hero → 03 HowItWorks
//     → 04 Differential → 05 Calculadora → 06 Taxas → 07 Invites
//     → 08 Testimonials → 09 ChaRifa → 10 CTAFinal → Footer
//
// The scroll-reveal IntersectionObserver runs after hydration and adds
// `.in` to every `.fade-up` section that enters view.
export function LandingPage() {
  // aperture-ydj4a — forward OAuth users back to their painel after the
  // social-login callback returns here with the ?oauth=1 marker.
  useOauthReturnRedirect();

  useEffect(() => {
    sendPageView('Landing');
  }, []);

  // aperture-ppuay — first-touch utm_source capture. Persist to localStorage so
  // it survives to identify-time (AuthModalProvider fires people.set_once after
  // the account resolves), attributing the account to its acquisition source.
  useEffect(() => {
    const utm = new URLSearchParams(window.location.search).get('utm_source');
    if (utm) window.localStorage.setItem('eunenem:utm_source', utm);
  }, []);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 },
    );
    document.querySelectorAll('.fade-up').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <>
      <Navbar />
      <Hero />
      <HowItWorks />
      <Differential />
      <Calculadora />
      <Taxas />
      <Invites />
      <Testimonials />
      <ChaRifa />
      <CTAFinal />
      <Footer />
    </>
  );
}
