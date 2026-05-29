import { useEffect } from 'react';
import { CTAFinal } from '@/components/eunenem/landing/CTAFinal';
import { Differential } from '@/components/eunenem/landing/Differential';
import { Footer } from '@/components/eunenem/landing/Footer';
import { Hero } from '@/components/eunenem/landing/Hero';
import { HowItWorks } from '@/components/eunenem/landing/HowItWorks';
import { Invites } from '@/components/eunenem/landing/Invites';
import { MediaBar } from '@/components/eunenem/landing/MediaBar';
import { Navbar } from '@/components/eunenem/landing/Navbar';
import { Showcase } from '@/components/eunenem/landing/Showcase';
import { Stats } from '@/components/eunenem/landing/Stats';
import { Testimonials } from '@/components/eunenem/landing/Testimonials';
import { TestimonialsHighlight } from '@/components/eunenem/landing/TestimonialsHighlight';

// aperture-q1j2 — marketing landing page served at "/". Mock-first, no
// backend/auth: a pure composition of static section components ported
// from the Next.js prototype (app/page.tsx). The scroll-reveal
// IntersectionObserver (originally page.tsx's useEffect) runs after
// hydration and adds `.in` to every `.fade-up` section that enters view.
export function LandingPage() {
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
      <Stats />
      <TestimonialsHighlight />
      <HowItWorks />
      <Differential />
      <Showcase />
      <Invites />
      <MediaBar />
      <Testimonials />
      <CTAFinal />
      <Footer />
    </>
  );
}
