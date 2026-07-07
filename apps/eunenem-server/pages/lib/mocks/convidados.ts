// aperture-x1b3u — mock data for /painel/[slug]/convidados (Lista de
// convidados / RSVP + convites por WhatsApp).
//
// The guest list itself (Convidado type / RSVP state) is wired to the
// real backend via `@/lib/convidados` — this file now only keeps the
// page-header event-meta placeholders + avatar helpers, which stay
// mocked (out of scope for the guest-list/RSVP integration).

/** Default WhatsApp invite copy, with [nome] / [link] variables. */
export const CONVIDADOS_DEFAULT_MESSAGE = `oi, [nome]! ♡

estou te convidando pro chá da maria — um momento bem afetivo pra celebrar a chegada dela em casa.

confirma pra mim? ♡ é só clicar aqui: [link]

vai ser tão lindo te ter por perto.`;

export const CONVIDADOS_DEFAULT_DATE = "sábado, 14 de junho";
export const CONVIDADOS_DEFAULT_TIME = "16h";
export const CONVIDADOS_DEFAULT_ADDRESS =
  "rua das laranjeiras, 482 — laranjeiras / rj";

/** Scrapbook-feeling event meta shown under the title. */
export const CONVIDADOS_EVENT = {
  date: "sábado, 14 de junho",
  time: "16h",
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
