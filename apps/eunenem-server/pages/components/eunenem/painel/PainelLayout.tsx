import type { ReactNode } from "react";

import { TweaksProvider } from "@/components/eunenem/TweaksContext";
import type { Genero } from "@/lib/concordancia";
import type { TweaksState } from "@/lib/mocks/tweaksDefaults";
import type { PainelSection } from "@/lib/painelRoutes";
import { CampanhaRotaProvider, useCampanhaRota } from "@/lib/campanha-rota";
import { PainelTopbar } from "./PainelTopbar";

// aperture-vv3i — Shared painel layout.
//
// Every authenticated /painel/:slug(/:section) page wraps its body in this:
// the TweaksProvider environment (so mock babyName/palette tweaks work
// everywhere), the common PainelTopbar, the 520px-mobile / fluid .painel-app
// shell (bottom padding + overflow guards already tuned in tailwind.css), and
// the TweaksPanel toggle. Page-specific content is passed as children — a
// page is then just `<PainelLayout slug>…body…</PainelLayout>`.
//
// aperture-fx2iz — Topbar now lives OUTSIDE .painel-app so its background
// band stretches edge-to-edge. The 1200px max-width constraint is only for
// the body shell; the header has its own inner max-width wrapper so the
// content row stays visually aligned with the body.

interface PainelLayoutProps {
  /** Creator slug (mock: "helena"). Used for routing + as the topbar key. */
  slug: string;
  /**
   * aperture-h0hom — the SPECIFIC campanha this painel is scoped to (from
   * the /painel/:slug/c/:idCampanha route). Provided to every descendant
   * via CampanhaRotaProvider so nav links preserve the context. undefined =
   * bare URL (oldest campanha, back-compat).
   */
  idCampanha?: string;
  /**
   * aperture-3ic62 — the REAL baby name from the creator's own profile
   * (`perfil.getPerfil` → nomeBebe). When provided, it seeds the Tweaks
   * babyName so the painel header reads "página da <Helena>".
   *
   * - A non-empty string seeds that name.
   * - An EXPLICIT empty string / null (creator hasn't set a baby name yet)
   *   seeds the neutral "bebê" default — NEVER the slug, which is the
   *   creator's OWN name and made the header read "página da Teste",
   *   repeating the greeting name.
   * - `undefined` (prop omitted, e.g. older sub-page callers) preserves the
   *   legacy slug-derived fallback so those pages are unchanged.
   */
  babyName?: string | null;
  /**
   * aperture-84a21 — the REAL event date (YYYY-MM-DD) from getPerfil.dataEvento.
   * - A non-empty string seeds the painel countdown + date chip.
   * - null/empty (creator hasn't set a date) seeds "" → PainelHeaderCard shows
   *   NO date (no mock "15 jun 2026").
   * - `undefined` (prop omitted, legacy sub-page callers) preserves the prior
   *   behaviour (the shared TWEAKS_DEFAULTS targetDate is left untouched).
   */
  eventDate?: string | null;
  /** aperture-neiwx — the baby's gender from getPerfil, seeds tweaks.genero so
   *  the owner header article ("página do/da/de") agrees with the guest page. */
  genero?: Genero | null;
  /** Current section, or undefined for the painel root (PainelPage). */
  activeSection?: PainelSection;
  children: ReactNode;
}

export function PainelLayout({
  slug,
  idCampanha,
  activeSection,
  babyName,
  eventDate,
  genero,
  children,
}: PainelLayoutProps) {
  // aperture-z6vks — INHERIT the route-level campanha context when the prop
  // is absent. The provider re-mounted here used to shadow App.tsx's
  // route-level CampanhaRotaProvider with `undefined` for callers that don't
  // thread the prop (PainelConvitePreviewPage), silently reverting every
  // descendant hook to the DEFAULT campanha. Prop (when passed) still wins.
  const idCampanhaRota = useCampanhaRota();
  const idCampanhaEfetiva = idCampanha ?? idCampanhaRota;
  // aperture-3ic62 — resolve the initial babyName seed:
  //   • prop provided + non-empty → the creator's real nomeBebe.
  //   • prop provided but empty/null → neutral "bebê" default (creator
  //     hasn't set a baby name). The slug is NEVER used as the baby name
  //     here — it is the creator's own name and made "página da <slug>"
  //     repeat the greeting name.
  //   • prop omitted (undefined) → legacy slug-derived fallback, so older
  //     sub-page callers that don't pass babyName keep their prior behaviour.
  const initialBabyName =
    babyName === undefined
      ? slug.charAt(0).toUpperCase() + slug.slice(1)
      : (babyName?.trim() || "bebê");

  // aperture-84a21 — seed the real event date when the prop is provided
  // (PainelPage). `undefined` (legacy callers) leaves TWEAKS_DEFAULTS as-is;
  // a real date seeds it; null/empty seeds "" so the header shows no date.
  const initialTweaks: Partial<TweaksState> =
    eventDate === undefined
      ? { babyName: initialBabyName }
      : { babyName: initialBabyName, targetDate: eventDate ?? "" };
  // aperture-neiwx — seed genero when the prop is provided (PainelPage), so the
  // owner header reads the same article the guest page does. Omitted (legacy
  // sub-page callers) → tweaks.genero stays null → neutral "de".
  if (genero !== undefined) initialTweaks.genero = genero;

  return (
    <CampanhaRotaProvider idCampanha={idCampanhaEfetiva}>
      <TweaksProvider initialState={initialTweaks}>
        <PainelTopbar slug={slug} activeSection={activeSection} />
        <div className="painel-app">{children}</div>
      </TweaksProvider>
    </CampanhaRotaProvider>
  );
}
