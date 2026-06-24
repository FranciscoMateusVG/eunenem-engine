import type { ReactNode } from "react";

import { TweaksProvider } from "@/components/eunenem/TweaksContext";
import type { PainelSection } from "@/lib/painelRoutes";
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
  /** Current section, or undefined for the painel root (PainelPage). */
  activeSection?: PainelSection;
  children: ReactNode;
}

export function PainelLayout({
  slug,
  activeSection,
  babyName,
  children,
}: PainelLayoutProps) {
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

  return (
    <TweaksProvider initialState={{ babyName: initialBabyName }}>
      <PainelTopbar slug={slug} activeSection={activeSection} />
      <div className="painel-app">{children}</div>
    </TweaksProvider>
  );
}
