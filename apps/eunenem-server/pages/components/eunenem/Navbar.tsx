
import { useEffect, useRef, useState } from "react";
import { CartButton } from "./CartButton";
import { useCartDrawer } from "./CartDrawerContext.js";

// aperture-3d9t — Navbar with scroll-aware blur backdrop.
//
// Logo + 3 anchor links (Presentes / Como funciona / Mural). Fixed
// position so it stays during scroll. Background goes from
// transparent → translucent-with-backdrop-blur once the page scrolls
// (Visual Identity Prompt §8 — navbar blur-on-scroll).
//
// Mobile (<sm: 640px) — aperture-hz7p caught a layout bug where the
// 3 inline links + logo overflowed viewport at 375px. Fix: collapse
// the link list into a hamburger-triggered dropdown below sm:. Above
// sm: the original inline ul renders unchanged. Both code paths
// share the same NAV_LINKS source-of-truth.

const NAV_LINKS = [
  { href: "#presentes", label: "Presentes" },
  { href: "#como", label: "Como funciona" },
  { href: "#mural", label: "Mural" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const drawer = useCartDrawer();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close the mobile dropdown when clicking outside, hitting Escape,
  // or resizing past the sm: breakpoint (desktop ul reappears, so
  // the dropdown is no longer relevant).
  useEffect(() => {
    if (!mobileOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!dropdownRef.current) return;
      if (dropdownRef.current.contains(e.target as Node)) return;
      setMobileOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    const onResize = () => {
      if (window.innerWidth >= 640) setMobileOpen(false);
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [mobileOpen]);

  return (
    <header
      className="fixed top-0 inset-x-0 z-40 transition-all duration-300"
      style={{
        background: scrolled
          ? "rgba(248, 247, 246, 0.85)"
          : "rgba(248, 247, 246, 0)",
        backdropFilter: scrolled ? "blur(16px) saturate(140%)" : "none",
        WebkitBackdropFilter: scrolled
          ? "blur(16px) saturate(140%)"
          : "none",
        borderBottom: scrolled
          ? "1px solid var(--line)"
          : "1px solid transparent",
      }}
    >
      <div className="eu-container flex items-center justify-between py-4">
        <a
          href="/pagina/francisco"
          className="flex items-center gap-2 no-underline"
          aria-label="EuNeném — início"
        >
          <span
            className="inline-flex items-center justify-center text-white font-bold"
            style={{
              width: 32,
              height: 32,
              borderRadius: 999,
              background: "var(--lilac-deep)",
              fontFamily: "var(--font-patrick-hand), cursive",
              fontSize: 22,
              lineHeight: 1,
              paddingBottom: 2,
            }}
            aria-hidden="true"
          >
            ♡
          </span>
          <span
            style={{
              fontFamily: "var(--font-patrick-hand), cursive",
              fontSize: 22,
              color: "var(--plum)",
              lineHeight: 1,
            }}
          >
            EuNeném
          </span>
        </a>

        {/* Desktop nav (sm+ only). Inline ul + cart button. */}
        <div className="hidden sm:flex items-center gap-3">
          <nav aria-label="Seções da página">
            <ul className="flex items-center gap-1 sm:gap-3 m-0 p-0 list-none">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className="inline-flex px-3 py-2 rounded-full text-sm font-semibold text-ink-soft hover:text-lilac-deep hover:bg-lilac-soft/60 transition-colors"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <CartButton onOpen={drawer.open} />
        </div>

        {/* Mobile nav (below sm). Hamburger toggles a dropdown, with the
            cart button sitting beside it so the visitor can reach the
            drawer without first opening the menu. Keeps the page within
            viewport width at 375/390/430. */}
        <div className="flex items-center gap-2 sm:hidden">
          <CartButton onOpen={drawer.open} />
          <div ref={dropdownRef} className="relative">
            <button
              type="button"
              aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            onClick={(e) => {
              e.stopPropagation();
              setMobileOpen((v) => !v);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 38,
              height: 38,
              borderRadius: 999,
              border: "1px solid var(--line)",
              background: "var(--paper)",
              color: "var(--plum)",
              boxShadow: "var(--shadow-sm)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {/* Hamburger icon — 3 stacked bars, rotates to X when open */}
            <svg
              width={18}
              height={18}
              viewBox="0 0 18 18"
              fill="none"
              aria-hidden="true"
              style={{
                transition: "transform 0.25s ease",
                transform: mobileOpen ? "rotate(90deg)" : "rotate(0deg)",
              }}
            >
              {mobileOpen ? (
                <path
                  d="M4 4 L14 14 M14 4 L4 14"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              ) : (
                <>
                  <path
                    d="M3 5 H15"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M3 9 H15"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M3 13 H15"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </>
              )}
            </svg>
          </button>

          {mobileOpen && (
            <nav
              id="mobile-nav"
              aria-label="Seções da página (mobile)"
              style={{
                position: "absolute",
                top: "calc(100% + 8px)",
                right: 0,
                minWidth: 200,
                background: "var(--paper)",
                border: "1px solid var(--line)",
                borderRadius: 16,
                boxShadow: "var(--shadow-md)",
                padding: 8,
                zIndex: 50,
              }}
            >
              <ul className="flex flex-col m-0 p-0 list-none">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      onClick={() => setMobileOpen(false)}
                      className="block px-3 py-2.5 rounded-lg text-sm font-semibold text-ink hover:text-lilac-deep hover:bg-lilac-soft/60 transition-colors no-underline"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          </div>
        </div>
      </div>
    </header>
  );
}
