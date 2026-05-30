import { useEffect, useRef, useState } from 'react';
import { NAV_LINKS } from '@/lib/mocks/landing';
import { useAuthModal } from '@/components/eunenem/auth/AuthModalProvider';
import { useMe, useSignOut } from '@/lib/auth';

// aperture-q1j2 — marketing landing navbar.
// aperture-nop8l — CTA wiring: "Entrar" + "criar minha lista" now both
// open the AuthModalShell instead of linking out to eunenem.com. Trigger
// refs are passed to useAuthModal().open() so focus restores correctly
// when the modal closes.
// aperture-tgkh3 — session-aware. When `auth.me` resolves to a real
// session, the two auth CTAs collapse into a single account chip
// (initial + first name + caret) that opens a dropdown with
// "Meu painel" → /painel/<slug> and "Sair" → tRPC signOut. The
// chip reads the user's slug from `auth.me` (Rex's PR #63), so the
// "Meu painel" link is always correct for whoever's signed in.
//
// Failure modes:
//   - me query loading on first paint → render neutral skeleton (avoids
//     a flash of "Entrar/criar minha lista" → chip swap on hydration)
//   - me query errored → fall back to anonymous CTAs (better to let the
//     user sign in again than block them on a transient error)
//   - signOut fired but tRPC errored → useSignOut swallows the error and
//     invalidates `me` regardless; navbar rerenders to anonymous on next
//     fetch (and the cookie is server-cleared on success anyway).
export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const auth = useAuthModal();
  const signinBtnRef = useRef<HTMLButtonElement | null>(null);
  const signupBtnRef = useRef<HTMLButtonElement | null>(null);

  const me = useMe();
  const { signOut, isPending: isSigningOut } = useSignOut();

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
        <div className="flex items-center gap-2 sm:gap-3 min-h-[44px]">
          {me.isPending ? (
            // Skeleton — same width as the chip so layout doesn't jump
            // when the query resolves. Animates softly so it reads as
            // "loading" rather than "broken empty box".
            <div
              aria-hidden="true"
              className="h-9 w-[136px] rounded-full bg-lilac-soft/40 animate-pulse"
            />
          ) : me.data ? (
            <AccountChip
              nomeExibicao={me.data.nomeExibicao}
              slug={me.data.slug}
              isSigningOut={isSigningOut}
              onSignOut={signOut}
            />
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

// ── Authenticated account chip ──────────────────────────────────────────────
//
// Renders the signed-in surface: a pill button (initial avatar + first
// name + caret) that toggles a small dropdown below-right. Two items —
// "Meu painel" (anchor → /painel/<slug>) and "Sair" (signOut).
//
// Dismiss model matches the existing mobile-nav pattern in the sibling
// Navbar.tsx so behavior feels consistent across the app: outside-click
// closes, ESC closes, opening pins focus on the first menu item so
// keyboard users land on a real interactive element.

interface AccountChipProps {
  nomeExibicao: string;
  slug: string;
  isSigningOut: boolean;
  onSignOut: () => Promise<void>;
}

function AccountChip({ nomeExibicao, slug, isSigningOut, onSignOut }: AccountChipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLAnchorElement | null>(null);

  const firstName = displayFirstName(nomeExibicao);
  const initial = firstName.charAt(0).toUpperCase() || '♡';

  // Outside-click + ESC + initial focus.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    const id = window.requestAnimationFrame(() => {
      firstItemRef.current?.focus();
    });
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.cancelAnimationFrame(id);
    };
  }, [open]);

  const handleSignOut = async () => {
    setOpen(false);
    await onSignOut();
    // Navbar rerenders automatically via useMe invalidation. We stay on
    // the current page per spec (no window.location.reload).
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Conta de ${firstName}. ${open ? 'Fechar menu' : 'Abrir menu'}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-paper border border-line shadow-soft-sm hover:shadow-md transition-shadow focus-visible:outline-2 focus-visible:outline-lilac-deep focus-visible:outline-offset-2"
        style={{ minHeight: 36 }}
      >
        <span
          className="inline-flex items-center justify-center text-white text-[13px] font-bold"
          style={{
            width: 28,
            height: 28,
            borderRadius: 999,
            background: 'var(--lilac-deep)',
            lineHeight: 1,
            paddingBottom: 1,
          }}
          aria-hidden="true"
        >
          {initial}
        </span>
        <span className="text-[13px] font-semibold text-ink tracking-wide leading-none">
          {firstName}
        </span>
        <svg
          width={10}
          height={10}
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden="true"
          style={{
            transition: 'transform 0.2s ease',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          <path
            d="M2 3.5 L5 6.5 L8 3.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-ink-soft"
          />
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Menu da conta"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: 200,
            background: 'var(--paper)',
            border: '1px solid var(--line)',
            borderRadius: 16,
            boxShadow: 'var(--shadow-md)',
            padding: 6,
            zIndex: 60,
          }}
        >
          <a
            ref={firstItemRef}
            role="menuitem"
            href={`/painel/${slug}`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold text-ink hover:text-lilac-deep hover:bg-lilac-soft/60 transition-colors no-underline focus-visible:outline-2 focus-visible:outline-lilac-deep focus-visible:outline-offset-1"
          >
            <span aria-hidden="true">♡</span>
            <span>Meu painel</span>
          </a>
          <button
            role="menuitem"
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
            className="w-full text-left flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-semibold text-ink hover:text-lilac-deep hover:bg-lilac-soft/60 transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-lilac-deep focus-visible:outline-offset-1"
          >
            <span aria-hidden="true">→</span>
            <span>{isSigningOut ? 'Saindo…' : 'Sair'}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * First word of the display name, trimmed. Mirrors the slug-derivation
 * "first word" rule from the engine domain (see src/domain/usuario/
 * slug-derivation.ts) — so when we render "Francisco" here it lines up
 * with "/painel/francisco" in the dropdown link without needing a
 * separate firstName field on auth.me.
 *
 * Falls back to the raw display name (or empty string) if splitting
 * produces nothing useful — defensive against degenerate names like
 * "  " or single-character handles.
 */
function displayFirstName(nomeExibicao: string): string {
  const trimmed = nomeExibicao.trim();
  if (!trimmed) return '';
  const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
  return firstWord;
}
