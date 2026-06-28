// aperture-3d9t — TweaksPanel default values + palette presets.
//
// All values live in-memory only — no localStorage, no persistence.
// The TweaksContext applies these to CSS vars on document root via
// useEffect.

import type { Genero } from "../concordancia";

export interface TweaksState {
  babyName: string;
  /** aperture-neiwx — baby's gender, drives PT-BR article/pronoun agreement
   *  across owner + guest surfaces. null = neutral (treated like neutro). */
  genero: Genero | null;
  parents: string;
  /** ISO date for the countdown target. */
  targetDate: string;
  /** Primary lilac — drives all CTAs + badges. */
  primary: string;
  /** Hover-shade for primary (used on btn-lilac:hover). */
  primaryDeep: string;
  /** Soft fill — chips + subtle backgrounds. */
  primarySoft: string;
  /** Coral accent — eyebrow signatures + child's name. */
  accent: string;
}

export const TWEAKS_DEFAULTS: TweaksState = {
  // aperture-slqtk — neutral fallback, NOT a real person's name. This default
  // surfaces on a creator's PUBLIC page when nomeBebe is null (more reachable
  // since aperture-0xoy0 lets photos persist before babyName is set). The old
  // "Francisco" demo value leaked a stranger's name onto real creators' pages.
  babyName: "bebê",
  genero: null,
  parents: "Mariana & Rodrigo",
  targetDate: "2026-06-15",
  primary: "#C9A5D8",
  primaryDeep: "#A77BBE",
  primarySoft: "#E8D5F0",
  accent: "#E78FA7",
};

/**
 * When the operator picks a primary swatch, the deep + soft variants
 * follow as a coherent triad. Without this, picking a new primary
 * would leave the hover + chip backgrounds out of sync with the
 * primary tone.
 */
export const PRIMARY_PRESETS: Record<
  string,
  { deep: string; soft: string }
> = {
  "#C9A5D8": { deep: "#A77BBE", soft: "#E8D5F0" }, // lilac
  "#9CD7DD": { deep: "#5FB4BB", soft: "#D6EEF1" }, // blue
  "#F4B6CD": { deep: "#D87B9F", soft: "#FBE0EA" }, // pink
  "#C7DC6E": { deep: "#8FAF3C", soft: "#E6EFC1" }, // green
};

export const PRIMARY_SWATCHES = Object.keys(PRIMARY_PRESETS);
export const ACCENT_SWATCHES = [
  "#E78FA7", // coral-pink
  "#A77BBE", // lilac-deep
  "#F7D560", // yellow
  "#5FB4BB", // blue-deep
];
