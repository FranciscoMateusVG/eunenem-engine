// aperture-x1b3u — mock data for /painel/[slug]/convidados (Lista de
// convidados / RSVP + convites por WhatsApp).
//
// In-memory only, no persistence. Ported from the "Lista de convidados"
// design export (app.jsx SEED_GUESTS + DEFAULT_MESSAGE). The page seeds
// React state from these and never writes back — every send / RSVP
// change / new guest lives in component state for the session.

/** RSVP state for a guest. Drives the badge + the confirmed count. */
export type ConvidadoRsvp = "confirmed" | "maybe" | "declined" | "pending";

export interface Convidado {
  id: number;
  name: string;
  phone: string;
  /** Whether the WhatsApp invite has already been sent. */
  sent: boolean;
  rsvp: ConvidadoRsvp;
  /** Whether a "talvez" guest has been nudged with a reminder. */
  reminded: boolean;
}

/** Seed list — matches the export's SEED_GUESTS (12 convidadas). */
export const CONVIDADOS_SEED: Convidado[] = [
  { id: 1, name: "ana clara mendes", phone: "(11) 99432-1187", sent: true, rsvp: "confirmed", reminded: false },
  { id: 2, name: "beatriz oliveira", phone: "(21) 98777-2231", sent: true, rsvp: "maybe", reminded: false },
  { id: 3, name: "camila ribeiro", phone: "(11) 97123-9988", sent: true, rsvp: "confirmed", reminded: false },
  { id: 4, name: "daniela monteiro", phone: "(31) 99876-4523", sent: true, rsvp: "declined", reminded: false },
  { id: 5, name: "eduarda farias", phone: "(11) 98765-1100", sent: false, rsvp: "pending", reminded: false },
  { id: 6, name: "fernanda azevedo", phone: "(11) 99000-2244", sent: true, rsvp: "confirmed", reminded: false },
  { id: 7, name: "gabriela siqueira", phone: "(11) 98432-7766", sent: true, rsvp: "maybe", reminded: true },
  { id: 8, name: "helena vasconcelos", phone: "(11) 99887-1234", sent: true, rsvp: "confirmed", reminded: false },
  { id: 9, name: "isadora pinheiro", phone: "(11) 99123-4567", sent: false, rsvp: "pending", reminded: false },
  { id: 10, name: "júlia bernardo", phone: "(11) 98321-6655", sent: true, rsvp: "confirmed", reminded: false },
  { id: 11, name: "letícia carvalho", phone: "(21) 97432-8899", sent: true, rsvp: "maybe", reminded: false },
  { id: 12, name: "mariana torres", phone: "(11) 98123-3344", sent: true, rsvp: "confirmed", reminded: false },
];

/** Default WhatsApp invite copy, with [nome] / [link] variables. */
export const CONVIDADOS_DEFAULT_MESSAGE = `oi, [nome]! ♡

estou te convidando pro chá da maria — um momento bem afetivo pra celebrar a chegada dela em casa.

será no dia 14 de junho, às 16h, lá em casa (rua das laranjeiras, 482 — laranjeiras / rj).

confirma pra mim? ♡ é só clicar aqui: [link]

vai ser tão lindo te ter por perto.`;

/** Scrapbook-feeling event meta shown under the title. */
export const CONVIDADOS_EVENT = {
  title: "chá da maria",
  date: "sábado, 14 de junho",
  location: "laranjeiras / rj",
};

/** RSVP label + token color per state — single source for badges. */
export const RSVP_META: Record<
  ConvidadoRsvp,
  { label: string; color: string }
> = {
  confirmed: { label: "confirmado", color: "var(--green-deep)" },
  maybe: { label: "talvez", color: "#c79b1d" },
  declined: { label: "não vai", color: "var(--coral-pink)" },
  pending: { label: "aguardando", color: "var(--ink-mute)" },
};

/** Soft pastel avatar palettes, picked deterministically by name. */
const AVATAR_PALETTES: { bg: string; fg: string }[] = [
  { bg: "var(--lilac-soft)", fg: "var(--lilac-deep)" },
  { bg: "var(--pink-soft)", fg: "var(--coral-pink)" },
  { bg: "color-mix(in srgb, var(--green) 32%, white)", fg: "var(--green-deep)" },
  { bg: "color-mix(in srgb, var(--yellow) 35%, white)", fg: "#8a6a14" },
  { bg: "color-mix(in srgb, var(--lilac) 28%, white)", fg: "var(--plum)" },
];

export function avatarFor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (
    AVATAR_PALETTES[h % AVATAR_PALETTES.length] ?? AVATAR_PALETTES[0]!
  );
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
}
