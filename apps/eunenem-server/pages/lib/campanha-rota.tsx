/**
 * aperture-h0hom (per-campanha routing, bvz0p Phase 1) — route-level campanha
 * context.
 *
 * When the user enters a SPECIFIC campanha's painel via
 * /painel/:slug/c/:idCampanha, every internal nav link (topbar, menu rows,
 * header CTA, section back-links) must PRESERVE that context — otherwise one
 * click silently swaps the user onto the oldest campanha (the exact bug this
 * phase fixes). Threading a prop through ~10 components would be noise; this
 * context carries it instead.
 *
 * `undefined` = the bare-URL world (oldest campanha, back-compat) — every
 * consumer passes it straight to painelHref/menuItemHref, whose optional
 * param handles both worlds.
 */
import { createContext, useContext, type ReactNode } from "react";

const CampanhaRotaContext = createContext<string | undefined>(undefined);

export function CampanhaRotaProvider({
  idCampanha,
  children,
}: {
  idCampanha?: string;
  children: ReactNode;
}) {
  return (
    <CampanhaRotaContext.Provider value={idCampanha}>
      {children}
    </CampanhaRotaContext.Provider>
  );
}

/** The idCampanha of the current painel route, or undefined (bare URL). */
export function useCampanhaRota(): string | undefined {
  return useContext(CampanhaRotaContext);
}
