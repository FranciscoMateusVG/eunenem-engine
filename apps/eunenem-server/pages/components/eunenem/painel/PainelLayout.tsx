import type { ReactNode } from "react";

import { TweaksPanel } from "@/components/eunenem/TweaksPanel";
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
  /** Creator slug (mock: "helena"). Seeds the Tweaks babyName default. */
  slug: string;
  /** Current section, or undefined for the painel root (PainelPage). */
  activeSection?: PainelSection;
  children: ReactNode;
}

export function PainelLayout({
  slug,
  activeSection,
  children,
}: PainelLayoutProps) {
  const initialBabyName = slug.charAt(0).toUpperCase() + slug.slice(1);

  return (
    <TweaksProvider initialState={{ babyName: initialBabyName }}>
      <PainelTopbar slug={slug} activeSection={activeSection} />
      <div className="painel-app">{children}</div>
      <TweaksPanel />
    </TweaksProvider>
  );
}
