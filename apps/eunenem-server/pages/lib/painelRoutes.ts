// aperture-vv3i — Painel routing convention (single source of truth).
//
// The router is hand-rolled (App.tsx resolveRoute + server.tsx status). This
// module is the ONE place that knows the set of authenticated /painel/:slug/
// :section sub-pages, how to build their hrefs, and which dashboard menu row
// points where. resolveRoute (validation/404), App.tsx (component dispatch via
// painelSections.tsx), and PainelMenuRow (href) all import from here so the
// three never drift.
//
// Mock-first: the only real creator slug is "helena" (matches App.tsx's
// existing hardcoded check). Backend/auth that resolves the signed-in user's
// real slug is a separate later epic.

/** Canonical authenticated painel sub-pages. Add a section here AND a page in
 *  painelSections.tsx when a page bead lands — both are required for the route
 *  to render its real component (otherwise it falls back to the placeholder). */
export const PAINEL_SECTIONS = [
  "presentes", // Presentes recebidos (statement + payout) — aperture-xjwc
  "lista", // Minha lista de presentes — aperture-4je0p
  "convite", // Convites (invite builder/preview) — aperture-q8rr
  "convidados", // Lista de convidados (RSVP) — aperture-x1b3u
  "mensagens", // Mensagens recebidas
  "perfil", // Editar perfil — aperture-1z6xa
  "bancarios", // Dados bancários (Pix/bank) — aperture-6xjcw
] as const;

export type PainelSection = (typeof PAINEL_SECTIONS)[number];

export function isPainelSection(value: string): value is PainelSection {
  return (PAINEL_SECTIONS as readonly string[]).includes(value);
}

/**
 * Build the canonical href for the dashboard root or a sub-section.
 *
 * aperture-h0hom (per-campanha routing, bvz0p Phase 1): pass `idCampanha` to
 * stay inside a SPECIFIC campanha's painel — the URL grows a `/c/:idCampanha`
 * segment (the `c` marker dodges the :section namespace). Omitted → the bare
 * URL, which keeps its historic meaning: resolve the OLDEST campanha
 * (back-compat for shared links).
 */
export function painelHref(
  slug: string,
  section?: PainelSection,
  idCampanha?: string,
): string {
  const base = idCampanha ? `/painel/${slug}/c/${idCampanha}` : `/painel/${slug}`;
  return section ? `${base}/${section}` : base;
}

/** Dedicated read-only preview route for the saved convite. */
export function painelConvitePreviewHref(slug: string, idCampanha?: string): string {
  // aperture-z6vks — preserve the /c/:idCampanha context so the preview
  // shows the CLICKED campanha's convite. Omitted → bare (oldest, back-compat).
  return idCampanha
    ? `/painel/${slug}/c/${idCampanha}/convite/preview`
    : `/painel/${slug}/convite/preview`;
}

/**
 * aperture-2v91z — canonical PUBLIC pagina path, prettiest available. Single
 * source for every /pagina link in the app (share chips, back-links, navbar
 * brand, menu rows) — inline `/pagina/${...}` builders are the leak class
 * this replaces (each one silently dropped the campanha context).
 *   campanhaSlug → /pagina/<slug>/<campanhaSlug>  (user-chosen pretty URL)
 *   idCampanha   → /pagina/<slug>/c/<idCampanha>  (canonical fallback)
 *   neither      → /pagina/<slug>                 (oldest, back-compat)
 */
export function paginaSharePath(
  slug: string,
  idCampanha?: string | null,
  campanhaSlug?: string | null,
): string {
  if (campanhaSlug) return `/pagina/${slug}/${campanhaSlug}`;
  return idCampanha ? `/pagina/${slug}/c/${idCampanha}` : `/pagina/${slug}`;
}

/** Display PATH for UI chips: "<user>/<campanha-slug>" | "<user>" (uuid
 *  stays out of pills; the copied URL carries it). */
export function paginaShareDisplayPath(slug: string, campanhaSlug?: string | null): string {
  return campanhaSlug ? `${slug}/${campanhaSlug}` : slug;
}

/** Public RSVP page a guest opens from a WhatsApp link — no auth required. */
export function confirmarPresencaHref(slug: string, idConvidado: string): string {
  return `/${slug}/confirmar-presenca/${idConvidado}`;
}

/**
 * Map a dashboard menu-row `id` (from painelDemo.buildPainelMenu) to its
 * destination href. Most ids map to a painel section; a couple are special:
 *   - `preview` ("ver como convidado") → the public contributor page
 *   - `suporte` ("fale com a gente") → external WhatsApp (no in-app page)
 *   - `rifa` is `soon` and never linked (PainelMenuRow disables it)
 * Returns `undefined` when the row should stay non-navigable.
 */
export function menuItemHref(
  slug: string,
  id: string,
  idCampanha?: string,
): string | undefined {
  switch (id) {
    case "presentes":
      return painelHref(slug, "presentes", idCampanha);
    case "lista":
      return painelHref(slug, "lista", idCampanha);
    case "convite":
      return painelHref(slug, "convite", idCampanha);
    case "lista-convidados":
      return painelHref(slug, "convidados", idCampanha);
    case "mensagens":
      return painelHref(slug, "mensagens", idCampanha);
    case "perfil":
      return painelHref(slug, "perfil", idCampanha);
    case "bancarios":
      return painelHref(slug, "bancarios", idCampanha);
    case "preview":
      // aperture-slqtk — "ver como convidado" → the logged-in creator's OWN
      // public page. Was hardcoded "/pagina/francisco" (the 3rd francisco
      // residue the V2 de-hardcode missed): it sent every non-francisco creator
      // to Francisco's page — which ALSO read as "my edits didn't save" because
      // they were viewing someone else's page. `slug` here is the real creator
      // slug (the same one every other row above already threads correctly).
      return paginaSharePath(slug, idCampanha);
    case "suporte":
      // External support channel — no in-app page in scope.
      return "https://wa.me/5531999999999";
    default:
      return undefined; // e.g. `rifa` (soon) — not navigable yet.
  }
}

/**
 * Copy for the not-yet-built section placeholder, keyed by section. Tone
 * follows the Sistema de Design §10 (pt-BR, afetivo). Each page bead removes
 * its reliance on this by registering a real component in painelSections.tsx.
 */
export const PAINEL_SECTION_META: Record<
  PainelSection,
  { eyebrow: string; title: string; note: string }
> = {
  presentes: {
    eyebrow: "quase lá ♡",
    title: "presentes recebidos",
    note: "Seu extrato de presentes e repasses está chegando.",
  },
  lista: {
    eyebrow: "feito com carinho ♡",
    title: "minha lista de presentes",
    note: "A edição da sua lista de presentes está a caminho.",
  },
  convite: {
    eyebrow: "um instante ♡",
    title: "ver meu convite",
    note: "O criador de convites está sendo preparado com carinho.",
  },
  convidados: {
    eyebrow: "quem vem ♡",
    title: "lista de convidados",
    note: "A lista de confirmações e convites está chegando.",
  },
  mensagens: {
    eyebrow: "recadinhos ♡",
    title: "mensagens recebidas",
    note: "Em breve você lê aqui todos os recados carinhosos.",
  },
  perfil: {
    eyebrow: "sobre você ♡",
    title: "editar meu perfil",
    note: "A edição de nome, foto e história do bebê está chegando.",
  },
  bancarios: {
    eyebrow: "seguro ♡",
    title: "dados bancários",
    note: "O cadastro de Pix e conta para repasse está a caminho.",
  },
};
