// next/image and next/link aren't available here (no Next). Use plain <a> and
// <img>. Width/height attributes preserve layout to avoid CLS.

// aperture-i01o — Painel topbar (sticky, blur backdrop).
//
// Logo (Thacy's logo.png asset) on the left; "minha página / TUTORIAL
// / ajuda" desktop nav in the middle (hidden under 900px per Thacy
// v3); two icon buttons (notifications, account) on the right. The
// notifications icon carries a coral-pink dot indicator when there's
// anything unread — wired off `hasNotif`.
//
// Translates Thacy's `.topbar` block from the v3 HTML mockup to
// Tailwind + design-token CSS vars. Wordmark was previously the
// Patrick Hand + heart-circle that Navbar.tsx uses on the marketing
// site — operator picked Thacy's actual brand asset (Option B,
// 2026-05-17) so the signed-in painel reads as the brand mark the
// rest of Thacy's deliverables use. Rendered via next/image so the
// 174×68 source asset gets webp/avif transcoding + lazy/eager
// loading control; `priority` is on because the logo is above the
// fold and visually anchors the topbar. CSS in globals.css scales
// height to 34px mobile, 40px desktop (>=900px).

interface PainelTopbarProps {
  hasNotif?: boolean;
  activeTab?: "minha-pagina" | "tutorial" | "ajuda";
}

const NAV_ITEMS: { id: PainelTopbarProps["activeTab"]; label: string }[] = [
  { id: "minha-pagina", label: "minha página" },
  { id: "tutorial", label: "TUTORIAL" },
  { id: "ajuda", label: "ajuda" },
];

export function PainelTopbar({
  hasNotif = true,
  activeTab = "minha-pagina",
}: PainelTopbarProps) {
  return (
    <header
      className="painel-topbar"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        background: "rgba(248, 247, 246, 0.86)",
        backdropFilter: "blur(16px) saturate(140%)",
        WebkitBackdropFilter: "blur(16px) saturate(140%)",
        borderBottom: "1px solid var(--line)",
        padding: "12px 18px",
        paddingTop: "calc(12px + env(safe-area-inset-top))",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      {/* Wordmark — Thacy's logo.png brand asset (operator picked
          Option B, 2026-05-17). Source is 174×68 RGBA; rendered at
          intrinsic ratio with CSS-controlled height (34px mobile /
          40px desktop) so the topbar's vertical rhythm matches the
          rest of the v3 mockup. `priority` because it's above the
          fold and visually anchors the topbar — Lighthouse LCP
          benefits, and avoids a paint flash on dev refresh. */}
      <a
        href="/painel/helena"
        className="painel-logo flex items-center no-underline"
        aria-label="EuNeném — início"
      >
        <img
          src="/public/logo.png"
          alt="EuNeném"
          width={174}
          height={68}
          className="painel-logo-img"
        />
      </a>

      {/* Desktop nav — appears at >=900px per Thacy v3 mockup. */}
      <nav aria-label="Painel — seções" className="painel-topbar-nav">
        <ul className="flex items-center gap-1 m-0 p-0 list-none">
          {NAV_ITEMS.map((item) => {
            const active = item.id === activeTab;
            return (
              <li key={item.id}>
                <a
                  href="#"
                  aria-current={active ? "page" : undefined}
                  className={`painel-topbar-link ${active ? "active" : ""}`}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={
            hasNotif ? "notificações (novas)" : "notificações"
          }
          className="painel-icon-btn"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ width: 18, height: 18 }}
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {hasNotif && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--coral-pink)",
                border: "1.5px solid var(--paper)",
              }}
            />
          )}
        </button>
        <button
          type="button"
          aria-label="minha conta"
          className="painel-icon-btn"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ width: 18, height: 18 }}
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        </button>
      </div>
    </header>
  );
}
