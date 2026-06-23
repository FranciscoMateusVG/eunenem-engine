
import { useEffect, useRef, useState } from "react";
import { CartButton } from "./CartButton";
import { useCartDrawer } from "./CartDrawerContext.js";

// aperture-3d9t / aperture-uk8q1 — visitor page header.
//
// Brand-aligned with the painel topbar (PainelTopbar): the shared
// EuNeném logo image (/public/logo.png) + chip-shaped nav links that
// mirror .painel-topbar-link (DM Sans, uppercase, lilac-soft active
// pill — see .eu-nav-chip in tailwind.css). Scroll-aware blur backdrop
// is kept (this is the public marketing-style page): background goes
// transparent → translucent-with-backdrop-blur once the page scrolls.
//
// What stays distinct from the painel (semantic, not cosmetic):
//   • nav items are SCROLL ANCHORS (Presentes / Como funciona / Mural),
//     not functional admin chips — the active chip is driven by a
//     scroll-spy (IntersectionObserver), highlighting the section in view.
//   • the right-side affordance is the CART (with count badge), not the
//     painel's bell + logout — the visitor is unauthenticated.
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

// aperture-t0ggy — the logo links back to the CURRENT page's slug (passed by
// PaginaPage / PaginaSucessoPage), not a hardcoded "/pagina/francisco". Falls
// back to the site root when no slug is supplied.
export function Navbar({ slug }: { slug?: string } = {}) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const drawer = useCartDrawer();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Scroll-spy — highlight the chip whose section is currently in view.
  // The rootMargin carves a thin band in the upper-middle of the viewport;
  // whichever section crosses it becomes active. Degrades gracefully: if
  // the anchor sections aren't present on the page, nothing is highlighted.
  useEffect(() => {
    const ids = NAV_LINKS.map((l) => l.href.slice(1));
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-40% 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
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

  const isActive = (href: string) => activeSection === href.slice(1);

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
          href={slug ? `/pagina/${slug}` : "/"}
          className="inline-flex items-center no-underline"
          aria-label="EuNeném — início"
        >
          <img src="/public/logo.png" alt="EuNeném" className="eu-nav-logo" />
        </a>

        {/* Desktop nav (sm+ only). Chip-shaped anchor links + cart button. */}
        <div className="hidden sm:flex items-center gap-3">
          <nav aria-label="Seções da página">
            <ul className="flex items-center gap-1 sm:gap-2 m-0 p-0 list-none">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    aria-current={isActive(link.href) ? "true" : undefined}
                    className={`eu-nav-chip${isActive(link.href) ? " is-active" : ""}`}
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
              <ul className="flex flex-col gap-1 m-0 p-0 list-none">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      onClick={() => setMobileOpen(false)}
                      aria-current={isActive(link.href) ? "true" : undefined}
                      className={`eu-nav-chip-block${isActive(link.href) ? " is-active" : ""}`}
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
