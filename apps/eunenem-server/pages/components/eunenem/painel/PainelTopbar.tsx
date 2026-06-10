import { painelHref, type PainelSection } from "@/lib/painelRoutes";

// aperture-7nius — Painel topbar redesign (3 chips).
//
// Phase B of plan 0018 — the operator's reference screenshots show a
// reduced top nav `MINHA PÁGINA / TUTORIAL / AJUDA`, replacing the
// previous 4-chip nav (`MINHA ÁREA / EXTRATO / CONVIDADOS / CONVITE`)
// from aperture-fx2iz. Decisions encoded here:
//
//   • MINHA PÁGINA  — renamed from MINHA ÁREA; same destination (painel
//                     root). The label is closer to the user's mental
//                     model of "my public page" vs "my admin area".
//   • TUTORIAL      — re-triggers the spotlight overlay (plan 0018 §"Re-
//                     trigger via floating CTA"). On the painel root this
//                     calls `onOpenTutorial`; on sub-pages it navigates
//                     to the painel root carrying `?tutorial=open` so
//                     the painel root auto-opens the overlay on land.
//   • AJUDA         — scrolls to the CONTA & AJUDA section of the painel
//                     grid (id `painel-group-conta` from PainelMenu).
//                     On sub-pages it navigates to the painel root with
//                     `#painel-group-conta` so the browser anchor-jumps.
//                     Lowest-friction: the section already contains the
//                     SUPORTE row pointing at WhatsApp, plus PERFIL and
//                     BANCÁRIOS — exactly the "help" surface area.
//
// Why this trio replaces the previous 4-chip nav: EXTRATO + CONVIDADOS +
// CONVITE already exist as rows in the painel grid (under SEU EVENTO and
// CONVIDADOS groups), so a top-nav duplicate was redundant. The new trio
// reflects the operator's reference screenshots and the painel's actual
// information architecture.

interface PainelTopbarProps {
  /** Creator slug — drives every nav href. */
  slug: string;
  /** Current section, or undefined when on the painel root (PainelPage). */
  activeSection?: PainelSection;
  /** Whether the bell shows the unread dot. Static-wired for now. */
  unread?: boolean;
  /** Painel-root-only: fires when the user clicks the TUTORIAL chip and
   *  we can open the overlay locally. When undefined (sub-pages), the
   *  chip falls back to `?tutorial=open` navigation. */
  onOpenTutorial?: () => void;
}

interface NavItem {
  label: string;
  /** undefined → painel root. */
  section?: PainelSection;
  /** Optional behavior key — when set, the chip is wired to the matching
   *  handler instead of being a plain anchor. */
  kind?: "page" | "tutorial" | "ajuda";
}

// Order matters — left-to-right per the reference screenshots.
const NAV_ITEMS: NavItem[] = [
  { label: "MINHA PÁGINA", kind: "page" },
  { label: "TUTORIAL", kind: "tutorial" },
  { label: "AJUDA", kind: "ajuda" },
];

export function PainelTopbar({
  slug,
  activeSection,
  unread = true,
  onOpenTutorial,
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
                      href={painelHref(slug, item.section)}
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

              // TUTORIAL — fires onOpenTutorial when we have it (painel
              // root); otherwise navigates with a flag so the root can
              // auto-open on land.
              if (item.kind === "tutorial") {
                if (onPainelRoot && onOpenTutorial) {
                  return (
                    <li key={item.label}>
                      <button
                        type="button"
                        onClick={onOpenTutorial}
                        className="painel-topbar-link painel-topbar-link-btn"
                      >
                        {item.label}
                      </button>
                    </li>
                  );
                }
                return (
                  <li key={item.label}>
                    <a
                      href={`${painelHref(slug)}?tutorial=open`}
                      className="painel-topbar-link"
                    >
                      {item.label}
                    </a>
                  </li>
                );
              }

              // AJUDA — anchor-jumps to the CONTA & AJUDA group on the
              // painel root. On sub-pages we navigate to the root with
              // the hash; on the root we just scroll via the # anchor
              // (the browser handles it).
              if (item.kind === "ajuda") {
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
              }

              return null;
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
