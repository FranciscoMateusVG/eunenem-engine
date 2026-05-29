import type { ReactNode } from "react";

import { BancariosBody } from "@/components/eunenem/painel/BancariosBody";
import { ConviteBody } from "@/components/eunenem/painel/ConviteBody";
import { ConvidadosBody } from "@/components/eunenem/painel/ConvidadosBody";
import { PainelLayout } from "@/components/eunenem/painel/PainelLayout";
import { PainelPlaceholder } from "@/components/eunenem/painel/PainelPlaceholder";
import { ListaPresentesBody } from "@/components/eunenem/painel/ListaPresentesBody";
import { MensagensBody } from "@/components/eunenem/painel/MensagensBody";
import { PerfilBody } from "@/components/eunenem/painel/PerfilBody";
import { PresentesBody } from "@/components/eunenem/painel/PresentesBody";
import type { PainelSection } from "@/lib/painelRoutes";

// aperture-vv3i — Painel sub-page dispatch + section registry.
//
// One file, one convention: a page bead for /painel/:slug/:section builds a
// BODY component (just the page's content — the topbar/shell/tweaks come from
// PainelLayout for free) and registers it in PAINEL_SECTION_PAGES below. Until
// it does, the section renders the on-brand PainelPlaceholder, so every route
// is live and reachable from day one.
//
// HOW TO ADD A PAGE (page-bead authors):
//   1. Build `PresentesBody({ slug }: PainelSectionBodyProps)` in
//      ./components/eunenem/painel/PresentesBody.tsx (content only — no layout).
//   2. Import it here and add ONE line to PAINEL_SECTION_PAGES:
//        presentes: PresentesBody,
//   That's the whole wiring. Keep entries one-per-line so parallel page PRs
//   merge cleanly.

export interface PainelSectionBodyProps {
  slug: string;
}

type PainelSectionBody = (props: PainelSectionBodyProps) => ReactNode;

/** Section → body component. Empty at foundation time; page beads fill it in.
 *  A missing entry falls back to PainelPlaceholder (see PainelSectionPage). */
export const PAINEL_SECTION_PAGES: Partial<
  Record<PainelSection, PainelSectionBody>
> = {
  presentes: PresentesBody,           // aperture-xjwc
  lista: ListaPresentesBody,          // aperture-4je0p
  convite: ConviteBody,               // aperture-q8rr
  convidados: ConvidadosBody,         // aperture-x1b3u
  mensagens: MensagensBody,           // aperture-1oafq
  perfil: PerfilBody, // aperture-1z6xa
  bancarios: BancariosBody, // aperture-6xjcw
};

export function PainelSectionPage({
  slug,
  section,
}: {
  slug: string;
  section: PainelSection;
}) {
  const Body = PAINEL_SECTION_PAGES[section];
  return (
    <PainelLayout slug={slug}>
      {Body ? <Body slug={slug} /> : <PainelPlaceholder slug={slug} section={section} />}
    </PainelLayout>
  );
}
