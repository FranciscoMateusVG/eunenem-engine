// aperture-q8rr — mock data + helpers for the Convites invite-builder wizard.
//
// Ported from the "Convites Desktop" export (shared.jsx + themes.jsx) into the
// painel foundation, mock-first. Two deliberate fidelity calls vs the export:
//   1. NAME_FONTS is restricted to the canonical pair (Patrick Hand + Caveat).
//      The export also offered Dancing Script + Shadows Into Light, which are
//      NOT in the EuNeném canonical font set — so they're dropped to keep the
//      page on-brand and asset-free (operator-confirmed canonical-fonts rule).
//   2. The template-watercolor + photo-upload preview modes need 12 PNG assets
//      we don't ship in this repo, so DEFAULT_STATE starts with no background
//      template — the pure-CSS "scrapbook" mode renders by default and nothing
//      can break on a missing asset. The wizard ships scrapbook + clean modes.

export type EventTypeId =
  | "cha-bebe"
  | "cha-fraldas"
  | "cha-surpresa"
  | "batizado"
  | "cha-revelacao"
  | "aniversario";

export interface EventType {
  id: EventTypeId;
  label: string;
  icon: string;
  emojiHint: string;
}

export const EVENT_TYPES: EventType[] = [
  { id: "cha-bebe", label: "chá de bebê", icon: "🍼", emojiHint: "✿ ☁ ♡" },
  { id: "cha-fraldas", label: "chá de fraldas", icon: "🧷", emojiHint: "☁ ♡" },
  { id: "cha-surpresa", label: "chá surpresa", icon: "🎀", emojiHint: "✨ ♡" },
  { id: "batizado", label: "batizado", icon: "🕊", emojiHint: "✦ ♡" },
  { id: "cha-revelacao", label: "chá revelação", icon: "🎈", emojiHint: "♡ ♂♀" },
  { id: "aniversario", label: "aniversário", icon: "🎂", emojiHint: "✦ ♡" },
];

export const EVENT_BY_ID: Record<string, EventType> = Object.fromEntries(
  EVENT_TYPES.map((e) => [e.id, e]),
);

export interface Palette {
  id: string;
  label: string;
  primary: string;
  deep: string;
  soft: string;
  accent: string;
  ink: string;
}

// Curated palettes — the chosen colours live *inside* the invite, independent
// of the site's design tokens, so these stay as literal hexes (they are data,
// not chrome).
export const PALETTES: Palette[] = [
  { id: "lilas", label: "lilás", primary: "#C9A5D8", deep: "#A77BBE", soft: "#E8D5F0", accent: "#E78FA7", ink: "#6B3C5E" },
  { id: "coral", label: "rosa-coral", primary: "#E78FA7", deep: "#D26A88", soft: "#FBE0EA", accent: "#F7D560", ink: "#6B3C5E" },
  { id: "lime", label: "verde-limão", primary: "#C7DC6E", deep: "#8AA53A", soft: "#E8F2C4", accent: "#9CD7DD", ink: "#3F5A1F" },
  { id: "azul", label: "azul claro", primary: "#9CD7DD", deep: "#5FB3BB", soft: "#D6EEF1", accent: "#F7D560", ink: "#1F4A52" },
  { id: "butter", label: "amarelo", primary: "#F7D560", deep: "#D9B23B", soft: "#FBEFC2", accent: "#C9A5D8", ink: "#6B3C5E" },
  { id: "cream", label: "cream", primary: "#EFE2E9", deep: "#A18A99", soft: "#F8F7F6", accent: "#C9A5D8", ink: "#5C3A4F" },
];

export const PALETTE_BY_ID: Record<string, Palette> = Object.fromEntries(
  PALETTES.map((p) => [p.id, p]),
);

export type NameFontId = "patrick" | "caveat";

export interface NameFont {
  id: NameFontId;
  label: string;
  css: string;
}

// Canonical pair only (see file header note 1).
export const NAME_FONTS: NameFont[] = [
  { id: "patrick", label: "patrick hand", css: "var(--font-patrick-hand), cursive" },
  { id: "caveat", label: "caveat", css: "var(--font-caveat), cursive" },
];

export const NAME_FONT_BY_ID: Record<string, NameFont> = Object.fromEntries(
  NAME_FONTS.map((f) => [f.id, f]),
);

export type EventMode = "presencial" | "online";
export type Fidelity = "scrapbook" | "clean";
export type PreviewFormat = "story" | "square" | "link";
export type Density = "pouca" | "media" | "muita";

export interface ConviteState {
  eventType: EventTypeId;
  mode: EventMode;
  babyName: string;
  host: string;
  date: string;
  time: string;
  address: string;
  onlineLink: string;
  hashtag: string;
  message: string;
  gifts: boolean;
  rsvp: boolean;
  showHashtag: boolean;
  palette: string;
  nameFont: NameFontId;
  density: Density;
  /** aperture-ghvfn — selected background template id, or "none" for plain
   *  scrapbook paper. The actual watercolor PNGs + template registry land in
   *  the sibling `fundo` bead (aperture-hzcy5); the shell carries the field. */
  bgTemplate: string;
  /** aperture-ghvfn — user-uploaded background image as a data URL, or null.
   *  Mutually exclusive with bgTemplate (set one, clear the other). The upload
   *  pipeline + preview renderer for it ship in aperture-hzcy5. */
  bgUpload: string | null;
}

export const DEFAULT_STATE: ConviteState = {
  eventType: "cha-bebe",
  mode: "presencial",
  babyName: "Maria Helena",
  host: "Mariana & Tiago",
  date: "2026-08-15",
  time: "15:00",
  address: "Rua das Acácias, 142\nVila Mariana — São Paulo",
  onlineLink: "meet.google.com/cha-mari",
  hashtag: "",
  message: "a gente já te ama tanto. vem celebrar com a gente essa nova fase ♡",
  gifts: true,
  rsvp: true,
  showHashtag: true,
  palette: "lilas",
  nameFont: "patrick",
  density: "media",
  bgTemplate: "none",
  bgUpload: null,
};

// ── date helpers ──────────────────────────────────────────────────────────

const MONTHS_FULL = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export interface ScrapDate {
  day: string;
  monthFull: string;
  year: number;
  weekday: string;
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function formatDateScrap(s: string): ScrapDate | null {
  const d = parseDate(s);
  if (!d) return null;
  return {
    day: String(d.getDate()).padStart(2, "0"),
    monthFull: MONTHS_FULL[d.getMonth()]!,
    year: d.getFullYear(),
    weekday: WEEKDAYS[d.getDay()]!,
  };
}

export interface Countdown {
  days: number;
  hours: number;
  mins: number;
}

export function countdownTo(dateStr: string, timeStr: string): Countdown | null {
  const d = parseDate(dateStr);
  if (!d) return null;
  if (timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    d.setHours(h || 0, m || 0);
  }
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return { days: 0, hours: 0, mins: 0 };
  return {
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff % 86400000) / 3600000),
    mins: Math.floor((diff % 3600000) / 60000),
  };
}
