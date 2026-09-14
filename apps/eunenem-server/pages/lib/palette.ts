// aperture-whxzg — palette helpers for the owner inline editor.
//
// The backend already accepts ANY `#rrggbb` for corPrimaria / corAcento
// (ConteudoPerfilCriadorSchema regex). What was preset-locked was the CLIENT:
// the deep/soft variants of the primary (CSS --lilac-deep / --lilac-soft,
// never persisted) only existed for the four PRIMARY_PRESETS. This module is
// the single derivation path used by every seed site (PaginaPage, TweaksPanel
// hydrate + pick) so a custom primary renders a coherent triad everywhere.
//
// Pure, DOM-free — unit-tested in node (tests/unit/server/whxzg-*.test.ts).

import { PRIMARY_PRESETS } from "./mocks/tweaksDefaults";

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#?([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/;
const HEX6_LOOSE = /^#?([0-9a-fA-F]{6})$/;

/**
 * Normalize user-typed colour text to the canonical `#RRGGBB` the backend
 * regex accepts, or `null` when the input is not a hex colour. Accepts
 * `#abc`, `abc`, `#aabbcc`, `aabbcc` (any case, surrounding whitespace).
 * Anything else — named colours, rgb(), url(), var(), `;`, `}` — is null:
 * a null NEVER reaches a CSS custom property or the save payload.
 */
export function normalizeHex(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 7) return null;
  const m6 = HEX6_LOOSE.exec(raw);
  if (m6?.[1]) return `#${m6[1].toUpperCase()}`;
  const m3 = HEX3.exec(raw);
  if (m3?.[1] && m3[2] && m3[3]) {
    return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toUpperCase();
  }
  return null;
}

/** True when `value` is already a canonical-shape `#rrggbb` (any case). */
export function isHex6(value: string | null | undefined): value is string {
  return typeof value === "string" && HEX6.test(value);
}

/** Is this primary one of the curated swatches? (case-insensitive) */
export function isPresetPrimary(hex: string): boolean {
  return findPreset(hex) !== undefined;
}

function findPreset(hex: string): { deep: string; soft: string } | undefined {
  const upper = hex.toUpperCase();
  for (const [key, triad] of Object.entries(PRIMARY_PRESETS)) {
    if (key.toUpperCase() === upper) return triad;
  }
  return undefined;
}

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };

function hexToRgb(hex: string): Rgb | null {
  const n = normalizeHex(hex);
  if (!n) return null;
  return {
    r: Number.parseInt(n.slice(1, 3), 16),
    g: Number.parseInt(n.slice(3, 5), 16),
    b: Number.parseInt(n.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3) * 255,
    g: hue2rgb(p, q, h) * 255,
    b: hue2rgb(p, q, h - 1 / 3) * 255,
  };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface PrimaryTriad {
  primary: string;
  primaryDeep: string;
  primarySoft: string;
}

/**
 * Deep (hover / badge text) + soft (chip fill) companions for a primary.
 * Curated presets return their hand-tuned pair; any other valid hex gets an
 * HSL-derived pair with the same lightness deltas the presets use
 * (≈ −13 L for deep, ≈ +15 L / desaturated for soft). Always returns three
 * canonical `#RRGGBB` strings; an invalid input falls back to the lilac
 * preset so the page never loses its palette.
 */
export function triadFor(primaryInput: string | null | undefined): PrimaryTriad {
  const primary = normalizeHex(primaryInput) ?? "#C9A5D8";
  const preset = findPreset(primary);
  if (preset) {
    return {
      primary,
      primaryDeep: preset.deep.toUpperCase(),
      primarySoft: preset.soft.toUpperCase(),
    };
  }
  const rgb = hexToRgb(primary);
  if (!rgb) return triadFor("#C9A5D8");
  const hsl = rgbToHsl(rgb);
  const deep = hslToRgb({
    h: hsl.h,
    s: clamp01(hsl.s + 0.06),
    l: clamp01(hsl.l - 0.13),
  });
  const soft = hslToRgb({
    h: hsl.h,
    s: clamp01(hsl.s * 0.85),
    l: clamp01(Math.max(hsl.l + 0.15, 0.86)),
  });
  return { primary, primaryDeep: rgbToHex(deep), primarySoft: rgbToHex(soft) };
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio between two hex colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return 1;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const PAPER_HEX = "#FFFFFF";
export const CTA_TEXT_HEX = "#FFFFFF";

export interface ContrastWarning {
  field: "primary" | "accent";
  ratio: number;
  message: string;
}

/**
 * INFORMATIONAL contrast check (operator: warn, never block or rewrite).
 *   • primary paints the CTA background under white 13px bold text → 4.5:1.
 *   • accent paints large display text (baby name, signature) on paper → 3:1.
 */
export function contrastWarnings(palette: {
  primary: string;
  accent: string;
}): ContrastWarning[] {
  const out: ContrastWarning[] = [];
  const primaryRatio = contrastRatio(palette.primary, CTA_TEXT_HEX);
  if (primaryRatio < 4.5) {
    out.push({
      field: "primary",
      ratio: primaryRatio,
      message: `contraste baixo com o texto branco dos botões (${primaryRatio.toFixed(1)}:1) — pode ficar difícil de ler`,
    });
  }
  const accentRatio = contrastRatio(palette.accent, PAPER_HEX);
  if (accentRatio < 3) {
    out.push({
      field: "accent",
      ratio: accentRatio,
      message: `contraste baixo com o fundo claro (${accentRatio.toFixed(1)}:1) — o nome pode sumir na página`,
    });
  }
  return out;
}
