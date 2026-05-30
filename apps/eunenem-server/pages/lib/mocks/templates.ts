// aperture-hzcy5 — Convites watercolor template registry.
//
// Ported from the canonical themes.jsx spec
// (.claude/aperture-attachments/eunenem-convites-redesign-2026-05-30/extracted/themes.jsx).
//
// Each template defines:
//   - the watercolor PNG asset (full-bleed background)
//   - a safe area (fractions of the canvas) where text can land without
//     covering the illustration
//   - an optional scrim (some templates have the illustration centered, so
//     the text needs a soft frosted backdrop to stay legible)
//   - a suggested palette + nameFont — picking a template silently cascades
//     these into the wizard state (preserve, no confirm, per direction-b)
//   - forEvents — pure-data filter used by suggestTemplates(eventType)
//
// Assets live at apps/eunenem-server/public/templates/<id>.png and are
// served at /public/templates/<id>.png (matches the rest of public/).
//
// AI suggest button was operator-dropped from the fundo step UI, but the
// suggestTemplates() pure helper is preserved — future consumers (e.g.
// curated event-type defaults) may still want it.

import type { EventTypeId, NameFontId } from "./convite";

export interface SafeArea {
  /** Fraction of canvas height reserved at the top (0..1). */
  top: number;
  /** Fraction of canvas height reserved at the bottom (0..1). */
  bottom: number;
  /** Fraction of canvas width reserved on the left (0..1). */
  left: number;
  /** Fraction of canvas width reserved on the right (0..1). */
  right: number;
}

export type ScrimKind = "none" | "soft";
export type TemplateAlign = "left" | "center";

export interface Template {
  id: string;
  label: string;
  emoji: string;
  /** Public URL of the watercolor PNG (root-relative). */
  img: string;
  /** Palette id from PALETTES — cascades into state on pick. */
  suggestedPalette: string;
  /** Name-font id from NAME_FONTS — cascades into state on pick. */
  suggestedNameFont: NameFontId;
  safeArea: SafeArea;
  align: TemplateAlign;
  scrim: ScrimKind;
  /** Event types this template is curated for (used by suggestTemplates). */
  forEvents: EventTypeId[];
}

export const TEMPLATES: Template[] = [
  {
    id: "varal-classico",
    label: "varal de mimos",
    emoji: "🧦",
    img: "/public/templates/varal-classico.png",
    suggestedPalette: "cream",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.4, bottom: 0.06, left: 0.1, right: 0.1 },
    align: "center",
    scrim: "none",
    forEvents: ["cha-bebe", "cha-fraldas", "batizado"],
  },
  {
    id: "balao-rosa",
    label: "balão de ar",
    emoji: "🎈",
    img: "/public/templates/balao-rosa.png",
    suggestedPalette: "coral",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.5, bottom: 0.06, left: 0.06, right: 0.06 },
    align: "center",
    scrim: "none",
    forEvents: ["cha-bebe", "aniversario", "cha-revelacao"],
  },
  {
    id: "jardim-romantico",
    label: "jardim romântico",
    emoji: "🌸",
    img: "/public/templates/jardim-romantico.png",
    suggestedPalette: "coral",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.24, bottom: 0.24, left: 0.1, right: 0.1 },
    align: "center",
    scrim: "none",
    forEvents: ["cha-bebe", "batizado", "aniversario"],
  },
  {
    id: "lavanda",
    label: "lavanda",
    emoji: "💜",
    img: "/public/templates/lavanda.png",
    suggestedPalette: "lilas",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.18, bottom: 0.1, left: 0.08, right: 0.45 },
    align: "left",
    scrim: "none",
    forEvents: ["cha-bebe", "batizado", "cha-fraldas"],
  },
  {
    id: "floresta-magica",
    label: "floresta mágica",
    emoji: "🍄",
    img: "/public/templates/floresta-magica.png",
    suggestedPalette: "cream",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.3, bottom: 0.42, left: 0.1, right: 0.1 },
    align: "center",
    scrim: "none",
    forEvents: ["cha-bebe", "aniversario", "batizado"],
  },
  {
    id: "varal-coracoes",
    label: "roupinhas & corações",
    emoji: "♡",
    img: "/public/templates/varal-coracoes.png",
    suggestedPalette: "coral",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.48, bottom: 0.06, left: 0.1, right: 0.1 },
    align: "center",
    scrim: "none",
    forEvents: ["cha-bebe", "cha-fraldas", "cha-revelacao"],
  },
  {
    id: "berco-floral",
    label: "berço floral",
    emoji: "🌿",
    img: "/public/templates/berco-floral.png",
    suggestedPalette: "coral",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.04, bottom: 0.04, left: 0.05, right: 0.05 },
    align: "center",
    scrim: "soft",
    forEvents: ["cha-bebe", "batizado"],
  },
  {
    id: "arco-iris-boho",
    label: "arco-íris boho",
    emoji: "🌈",
    img: "/public/templates/arco-iris-boho.png",
    suggestedPalette: "coral",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.3, bottom: 0.34, left: 0.1, right: 0.1 },
    align: "center",
    scrim: "none",
    forEvents: ["aniversario", "cha-bebe", "cha-revelacao"],
  },
  {
    id: "margaridas",
    label: "margaridas",
    emoji: "🌼",
    img: "/public/templates/margaridas.png",
    suggestedPalette: "butter",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.3, bottom: 0.22, left: 0.16, right: 0.16 },
    align: "center",
    scrim: "none",
    forEvents: ["aniversario", "cha-bebe", "batizado"],
  },
  {
    id: "girafa-bailarina",
    label: "girafinha bailarina",
    emoji: "🩰",
    img: "/public/templates/girafa-bailarina.png",
    suggestedPalette: "coral",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.1, bottom: 0.12, left: 0.06, right: 0.5 },
    align: "left",
    scrim: "none",
    forEvents: ["cha-bebe", "aniversario", "cha-revelacao"],
  },
  {
    id: "safari-girafa",
    label: "safari",
    emoji: "🦒",
    img: "/public/templates/safari-girafa.png",
    suggestedPalette: "coral",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.3, bottom: 0.42, left: 0.1, right: 0.1 },
    align: "center",
    scrim: "none",
    forEvents: ["cha-bebe", "aniversario", "cha-fraldas"],
  },
  {
    id: "elefante-balao",
    label: "elefantinho",
    emoji: "🐘",
    img: "/public/templates/elefante-balao.png",
    suggestedPalette: "cream",
    suggestedNameFont: "caveat",
    safeArea: { top: 0.42, bottom: 0.06, left: 0.1, right: 0.1 },
    align: "center",
    scrim: "none",
    forEvents: ["cha-bebe", "aniversario", "cha-revelacao"],
  },
];

export const TEMPLATE_BY_ID: Record<string, Template> = Object.fromEntries(
  TEMPLATES.map((t) => [t.id, t]),
);

/**
 * Filters TEMPLATES to those curated for the given event type. Pure data,
 * no UI surface in aperture-hzcy5 — kept so future curated-default consumers
 * (or a returning AI-suggest CTA) can use it without re-deriving.
 */
export function suggestTemplates(eventType: EventTypeId): Template[] {
  return TEMPLATES.filter((t) => t.forEvents.includes(eventType));
}
