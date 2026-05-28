import type { ReactNode } from "react";

import { TweaksPanel } from "@/components/eunenem/TweaksPanel";
import { TweaksProvider } from "@/components/eunenem/TweaksContext";
import { PainelTopbar } from "./PainelTopbar";

// aperture-vv3i — Shared painel layout.
//
// Every authenticated /painel/:slug(/:section) page wraps its body in this:
// the TweaksProvider environment (so mock babyName/palette tweaks work
// everywhere), the sticky PainelTopbar, the 520px-mobile / fluid .painel-app
// shell (bottom padding + overflow guards already tuned in tailwind.css), and
// the TweaksPanel toggle. Page-specific content is passed as children — a
// page is then just `<PainelLayout slug>…header + body…</PainelLayout>`.
//
// Keeping the chrome here means the 9 sub-pages stay focused on their unique
// content and inherit identical topbar/shell/tweaks behaviour for free.

interface PainelLayoutProps {
  /** Creator slug (mock: "helena"). Seeds the Tweaks babyName default. */
  slug: string;
  /** Highlighted topbar tab. Defaults to "minha-pagina". */
  activeTab?: "minha-pagina" | "tutorial" | "ajuda";
  children: ReactNode;
}

export function PainelLayout({
  slug,
  activeTab = "minha-pagina",
  children,
}: PainelLayoutProps) {
  const initialBabyName = slug.charAt(0).toUpperCase() + slug.slice(1);

  return (
    <TweaksProvider initialState={{ babyName: initialBabyName }}>
      <div className="painel-app">
        <PainelTopbar activeTab={activeTab} />
        {children}
      </div>
      <TweaksPanel />
    </TweaksProvider>
  );
}
