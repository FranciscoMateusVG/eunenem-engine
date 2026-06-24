import { painelHref, type PainelSection } from "@/lib/painelRoutes";

// aperture-7nius / aperture-0mplv — Painel topbar nav.
//
// The logged-in painel topbar carries the EuNeném logo, a small set of
// nav chips, and the bell + logout icon buttons.
//
// aperture-0mplv removed the TUTORIAL chip: the spotlight overlay is
// still re-triggerable via the floating bottom-right CTA
// (PainelTutorialTrigger on PainelPage), so a duplicate top-nav entry
// was redundant. The topbar nav is now the two destinations that map to
// real painel surfaces:
//
//   • MINHA PÁGINA  — anchors to the painel root; active when there's no
//                     sub-section.
//   • AJUDA         — anchor-jumps to the CONTA & AJUDA group on the
//                     painel root (id `painel-group-conta` from
//                     PainelMenu). On sub-pages it navigates to the root
//                     carrying `#painel-group-conta` so the browser
//                     anchor-jumps on land. The section already gathers
//                     SUPORTE (WhatsApp) + PERFIL + BANCÁRIOS — exactly
//                     the "help" surface area.

interface PainelTopbarProps {
  /** Creator slug — drives every nav href. */
  slug: string;
  /** Current section, or undefined when on the painel root (PainelPage). */
  activeSection?: PainelSection;
  /** Whether the bell shows the unread dot. Static-wired for now. */
  unread?: boolean;
}

interface NavItem {
  label: string;
  /** Behavior key — selects how the chip resolves its href + active state. */
  kind: "page" | "ajuda";
}

// Order matters — left-to-right per the reference screenshots.
const NAV_ITEMS: NavItem[] = [
  { label: "MINHA PÁGINA", kind: "page" },
  { label: "AJUDA", kind: "ajuda" },
];

export function PainelTopbar({
  slug,
  activeSection,
  unread = true,
}: PainelTopbarProps) {
  const onPainelRoot = activeSection === undefined;

  return (
    <header className="painel-topbar" aria-label="Painel — navegação">
      <div className="painel-topbar-inner">
        <a
          href={painelHref(slug)}
          className="painel-topbar-brand"
          aria-label="EuNeném — painel"
        >
          <img
            src="/public/logo.png"
            alt="EuNeném"
            width={174}
            height={68}
            className="painel-logo-img"
          />
        </a>

        <nav className="painel-topbar-nav" aria-label="Seções do painel">
          <ul>
            {NAV_ITEMS.map((item) => {
              // MINHA PÁGINA — anchor to painel root, active when there's
              // no sub-section.
              if (item.kind === "page") {
                const active = onPainelRoot;
                return (
                  <li key={item.label}>
                    <a
                      href={painelHref(slug)}
                      aria-current={active ? "page" : undefined}
                      className={`painel-topbar-link${
                        active ? " is-active" : ""
                      }`}
                    >
                      {item.label}
                    </a>
                  </li>
                );
              }

              // AJUDA — anchor-jumps to the CONTA & AJUDA group on the
              // painel root. On sub-pages we navigate to the root with the
              // hash; on the root we just scroll via the # anchor.
              const href = onPainelRoot
                ? "#painel-group-conta"
                : `${painelHref(slug)}#painel-group-conta`;
              return (
                <li key={item.label}>
                  <a href={href} className="painel-topbar-link">
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="painel-topbar-actions">
          <button
            type="button"
            aria-label={unread ? "notificações (novas)" : "notificações"}
            className="painel-topbar-icon-btn"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              width={18}
              height={18}
            >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
            {unread && <span aria-hidden="true" className="badge-dot" />}
          </button>
          <button
            type="button"
            aria-label="sair"
            className="painel-topbar-icon-btn"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              width={18}
              height={18}
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
