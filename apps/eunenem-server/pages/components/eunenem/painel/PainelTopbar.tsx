import {
  conviteDestinationHref,
  useConvitePreviewData,
} from "@/lib/convite";
import { painelHref, type PainelSection } from "@/lib/painelRoutes";

// aperture-fx2iz — Common full-width painel topbar.
//
// Single header used by every /painel/:slug(/:section) route. Three zones,
// rendered in a centered max-width row that sits inside a full-viewport-width
// background band:
//   • Brand block on the left — Thacy's logo.png wordmark, linking back to the
//     painel root.
//   • 4 centered nav links — MINHA ÁREA / EXTRATO / CONVIDADOS / CONVITE.
//     Operator-confirmed exactly 4 buttons (no LISTA, no PERFIL); see the bead
//     brief — earlier sketches mentioned a 5th-button placeholder, dropped.
//   • Circular icon-buttons on the right — notifications bell (carries a coral
//     dot when `unread` is true; wired static for now) + logout (arrow-out-of-
//     box). Same visual treatment as the existing painel header (see 26.png).
//
// Active state: the link matching `activeSection` (or the MINHA ÁREA link when
// `activeSection` is undefined, i.e. the painel root) renders as a soft-purple
// pill — `var(--lilac-soft)` background, `var(--plum)` text. Inactive links
// stay plain text in `var(--ink)`.
//
// Hrefs come from painelHref() so paths never drift from the routing source of
// truth in lib/painelRoutes.ts.

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
  /** undefined → MINHA ÁREA (the painel root). */
  section?: PainelSection;
}

// Order matters — left-to-right per the brief.
const NAV_ITEMS: NavItem[] = [
  { label: "MINHA ÁREA" },
  { label: "EXTRATO", section: "presentes" },
  { label: "CONVIDADOS", section: "convidados" },
  { label: "CONVITE", section: "convite" },
];

export function PainelTopbar({
  slug,
  activeSection,
  unread = true,
}: PainelTopbarProps) {
  const conviteQuery = useConvitePreviewData(slug);

  return (
    <header className="painel-topbar" aria-label="Painel — navegação">
      <div className="painel-topbar-inner">
        <a
          href={painelHref(slug)}
          className="painel-topbar-brand"
          aria-label="EuNeném — painel"
        >
          {/* Thacy's logo asset — the "ee NENEM" colorful wordmark. The
              .painel-logo-img rule already height-controls it (34px mobile /
              40px desktop) so we keep the same visual rhythm. */}
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
              const active = item.section === activeSection;
              const href = item.section === "convite"
                ? conviteDestinationHref(slug, conviteQuery.data)
                : painelHref(slug, item.section);
              return (
                <li key={item.label}>
                  <a
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`painel-topbar-link${
                      active ? " is-active" : ""
                    }`}
                  >
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
            {/* Logout — arrow-out-of-box (door + arrow pointing right). */}
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
