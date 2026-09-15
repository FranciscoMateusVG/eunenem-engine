// aperture-4e1qo — owner shortcut from the public gift page to the painel
// editor of the campanha ACTUALLY being displayed.
//
// Ownership is never inferred from "logged in": the only source is the
// server-resolved public projection (getPerfilPublicoBySlug), whose
// `isOwner` is true iff the caller's session administers THIS campanha
// (same source PR #117's inline-edit icons use). The href always carries
// the /c/:idCampanha segment — a bare /painel/:slug/lista resolves the
// OLDEST campanha, which is the wrong list whenever the owner has several.
//
// Pure, DOM-free — node-tested.

import { painelHref } from "./painelRoutes";

export interface OwnerProjection {
  isOwner?: boolean | null;
  /** The campanha this page was resolved from; null when the conta has none. */
  idCampanha?: string | null;
  /** Creator's usuario slug — the painel slug (NOT a campanha pretty slug). */
  slug?: string | null;
}

/**
 * Fail-closed: returns the painel "lista" href ONLY when the projection is
 * loaded, the caller is the owner, and both the campanha id and the creator
 * slug are known. Loading (undefined), errors, guests, signed-out visitors
 * and other owners all get `null` → the link is not in the tree.
 */
export function ownerListaEditHref(projection: OwnerProjection | null | undefined): string | null {
  if (!projection) return null;
  if (projection.isOwner !== true) return null;
  const idCampanha = projection.idCampanha?.trim();
  const slug = projection.slug?.trim();
  if (!idCampanha || !slug) return null;
  return painelHref(slug, "lista", idCampanha);
}

export const OWNER_EDIT_LISTA_LABEL = "Editar lista de presentes";
