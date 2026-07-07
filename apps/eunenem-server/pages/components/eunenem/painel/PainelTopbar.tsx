import { useSignOut } from "@/lib/auth";
import { painelHref, type PainelSection } from "@/lib/painelRoutes";

// aperture-7nius / aperture-0mplv / aperture-paf3m — Painel topbar nav.
//
// The logged-in painel topbar carries the EuNeném logo, a single nav chip,
// and the logout icon button.
//
// aperture-0mplv removed the TUTORIAL chip; aperture-paf3m removed the AJUDA
// chip (operator request) — the CONTA & AJUDA surface (SUPORTE/WhatsApp +
// PERFIL + BANCÁRIOS) is still reachable by scrolling the painel root menu,
// so a dedicated top-nav anchor was redundant. The topbar nav is now just:
//
//   • MINHAS LISTAS — back to /campanhas (aperture-hdftp: a multi-campaign
//                     user who entered a list was stranded — no way back to
//                     the mixed 1.0/2.0 grid). Leads the nav (back-affordance
//                     reads left), never active inside the painel.
//   • MINHA PÁGINA  — anchors to the painel root; active when there's no
//                     sub-section.

interface PainelTopbarProps {
  /** Creator slug — drives every nav href. */
  slug: string;
  /** Current section, or undefined when on the painel root (PainelPage). */
  activeSection?: PainelSection;
  /**
   * aperture-hdftp — which top-level surface is current. On 'campanhas'
   * (the /campanhas multi-list grid) the MINHAS LISTAS chip renders as
   * the active you-are-here chip (no back arrow) and MINHA PÁGINA is
   * never active. Defaults to 'painel' (all /painel/:slug surfaces).
   */
  surface?: 'painel' | 'campanhas';
}

export function PainelTopbar({
  slug,
  activeSection,
  surface = 'painel',
}: PainelTopbarProps) {
  const onCampanhas = surface === 'campanhas';
  const onPainelRoot = !onCampanhas && activeSection === undefined;
  // aperture-1wknu — wire the previously-dead logout button (it was a bare
  // <button> with no onClick, so clicking did nothing).
  const { signOut, isPending: isSigningOut } = useSignOut();

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
            {/* aperture-hdftp — back to the multi-campaign grid. Leads the
             *  nav (back-affordances read left-first); the stroke arrow
             *  follows the topbar's SVG icon convention (logout button). */}
            <li>
              <a
                href="/campanhas"
                aria-current={onCampanhas ? "page" : undefined}
                className={`painel-topbar-link painel-topbar-link--listas${onCampanhas ? " is-active" : ""}`}
                data-testid="topbar-minhas-listas"
              >
                {/* Back arrow only when this chip IS a back-affordance —
                 *  on /campanhas itself the chip is "you are here". */}
                {!onCampanhas && (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    width={14}
                    height={14}
                  >
                    <line x1="19" y1="12" x2="5" y2="12" />
                    <polyline points="12 19 5 12 12 5" />
                  </svg>
                )}
                MINHAS LISTAS
              </a>
            </li>
            {/* MINHA PÁGINA — anchor to painel root, active when there's
             *  no sub-section. (aperture-paf3m: AJUDA branch removed.) */}
            <li>
              <a
                href={painelHref(slug)}
                aria-current={onPainelRoot ? "page" : undefined}
                className={`painel-topbar-link${onPainelRoot ? " is-active" : ""}`}
              >
                MINHA PÁGINA
              </a>
            </li>
          </ul>
        </nav>

        <div className="painel-topbar-actions">
          {/* aperture-1wknu — notification bell removed (operator request). */}
          <button
            type="button"
            aria-label="sair"
            className="painel-topbar-icon-btn"
            disabled={isSigningOut}
            onClick={async () => {
              // aperture-1wknu — was a no-op bare button. Sign out, then
              // hard-redirect to the public landing so the authed painel is
              // fully left and the cleared session takes effect.
              await signOut();
              window.location.assign("/");
            }}
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
