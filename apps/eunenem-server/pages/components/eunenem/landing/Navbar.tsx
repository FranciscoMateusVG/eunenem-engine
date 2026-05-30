import { useEffect, useRef, useState } from 'react';
import { NAV_LINKS } from '@/lib/mocks/landing';
import { useAuthModal } from '@/components/eunenem/auth/AuthModalProvider';

// aperture-q1j2 — marketing landing navbar.
// aperture-nop8l — CTA wiring: "Entrar" + "criar minha lista" now both
// open the AuthModalShell instead of linking out to eunenem.com. Trigger
// refs are passed to useAuthModal().open() so focus restores correctly
// when the modal closes.
export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const auth = useAuthModal();
  const signinBtnRef = useRef<HTMLButtonElement | null>(null);
  const signupBtnRef = useRef<HTMLButtonElement | null>(null);

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
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            ref={signinBtnRef}
            type="button"
            onClick={() => auth.open('signin', signinBtnRef.current)}
            className="text-[13px] font-semibold text-ink hover:text-lilac-deep transition-colors tracking-wide px-2 py-2 rounded-lg focus-visible:outline-2 focus-visible:outline-lilac-deep focus-visible:outline-offset-2"
          >
            Entrar
          </button>
          <button
            ref={signupBtnRef}
            type="button"
            onClick={() => auth.open('signup', signupBtnRef.current)}
            className="btn-lilac !py-3 !px-5 !text-[12px]"
          >
            criar minha lista
          </button>
        </div>
      </div>
    </nav>
  );
}
