import { useEffect, useState } from 'react';
import { LANDING_LINKS, NAV_LINKS } from '@/lib/mocks/landing';

// aperture-q1j2 — marketing landing navbar (ported from the Next.js
// prototype). Sticky, transparent at top, frosted + bordered once
// scrolled. Mock-first: every CTA points at the real eunenem.com app.
export function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav
      className={`sticky top-0 z-50 transition-all border-b ${
        scrolled
          ? 'bg-cream/85 backdrop-blur-md border-line shadow-[0_2px_12px_rgba(107,60,94,0.05)]'
          : 'bg-cream/50 border-transparent'
      }`}
    >
      <div className="mx-auto max-w-[1200px] px-6 py-3.5 flex items-center justify-between gap-6">
        <a href="#" aria-label="EuNeném" className="flex items-center">
          <img
            src="/public/logo-landing.png"
            alt="EuNeném"
            width={180}
            height={52}
            className="h-13 w-auto"
          />
        </a>
        <ul className="hidden lg:flex gap-8 list-none">
          {NAV_LINKS.map(([label, href]) => (
            <li key={href}>
              <a
                href={href}
                className="text-sm font-semibold text-ink hover:text-lilac-deep transition-colors tracking-wide"
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
        <a
          href={LANDING_LINKS.criarLista}
          className="btn-lilac !py-3 !px-5 !text-[12px]"
        >
          criar minha lista
        </a>
      </div>
    </nav>
  );
}
