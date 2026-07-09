// aperture-1yx1n (+ fixes aperture-ugttj) — THE single seam for public
// pagina share URLs.
//
// Every share/display affordance for the visitor page builds its URL HERE.
// Two bugs this closes:
//   1. ugttj: share surfaces hardcoded the LEGACY domain + wrong path
//      ("eunenem.com/<slug>") — a dead link on both axes. The real public
//      page lives at <origin>/pagina/<slug>.
//   2. Campanha addressing: with multiple listas, a share link must target
//      the CLICKED campanha (/pagina/<slug>/c/<idCampanha>), or the guest
//      lands on the oldest one.
//
// PRETTY-SLUG SWAP POINT (W1a, aperture-aphk8): when Rex's per-campanha
// slug resolution lands, /pagina/<user-slug>/<campanha-slug> replaces the
// /c/<uuid> form — change paginaSharePath (and ONLY it); every consumer
// follows.

import { getDefaultConviteShareOrigin } from './convite-share.js';

/** Path form: /pagina/<slug> or /pagina/<slug>/c/<idCampanha>. */
export function paginaSharePath(slug: string, idCampanha?: string | null): string {
  return idCampanha ? `/pagina/${slug}/c/${idCampanha}` : `/pagina/${slug}`;
}

/** Absolute URL for clipboard/share payloads. */
export function paginaShareUrl(slug: string, idCampanha?: string | null): string {
  return new URL(paginaSharePath(slug, idCampanha), getDefaultConviteShareOrigin()).toString();
}

/**
 * Protocol-less display prefix for UI chips/inputs ("<host>/pagina/").
 * Display intentionally omits the /c/<uuid> tail — a 36-char UUID is visual
 * noise in a pill; the COPIED url (paginaShareUrl) carries the full
 * addressing. Both converge once pretty campanha slugs land.
 */
export function paginaShareDisplayPrefix(): string {
  const origin = getDefaultConviteShareOrigin().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `${origin}/pagina/`;
}
