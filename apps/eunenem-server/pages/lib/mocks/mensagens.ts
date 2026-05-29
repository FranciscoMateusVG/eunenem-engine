// aperture-1oafq — mock data for /painel/[slug]/mensagens (Mensagens
// recebidas / recados de quem presenteou).
//
// In-memory only, no persistence. There is no dedicated design export for
// this page, so the data shape is built design-consistent with the EuNeném
// Sistema de Design and the sibling painel bodies (convidados / presentes):
// each recado pairs an affectionate pt-BR message with the gift the
// contributor gave. The page seeds React state from RECADOS_SEED and never
// writes back — marking-as-read / "agradecer" all live in component state
// for the session.

/** A recado left by someone who gave a gift. */
export interface Recado {
  id: number;
  /** Contributor name (lowercase, scrapbook tone). */
  name: string;
  /** Affectionate message left at checkout, pt-BR. */
  message: string;
  /** Human label for the gift given (e.g. "kit body"). */
  giftLabel: string;
  /** Amount given, in cents. */
  valueCents: number;
  /** Pretty date the recado arrived ("22 mai"). */
  date: string;
  /** Whether the creator has already read this recado. */
  read: boolean;
}

/** Seed list — 10 recados, mix of read / unread, varied gifts + tones. */
export const RECADOS_SEED: Recado[] = [
  {
    id: 1,
    name: "tia rosângela",
    message:
      "que alegria imensa te esperar, pequeno! a titia já está contando os dias pra encher você de beijos. ♡",
    giftLabel: "kit body recém-nascido",
    valueCents: 12000,
    date: "24 mai",
    read: false,
  },
  {
    id: 2,
    name: "vovó cleide",
    message:
      "meu neto amado, a vovó preparou esse cantinho com todo amor do mundo. mal posso esperar pra te ninar. te amo antes mesmo de te conhecer.",
    giftLabel: "berço + enxoval",
    valueCents: 48000,
    date: "23 mai",
    read: false,
  },
  {
    id: 3,
    name: "carol e thiago",
    message:
      "pra começar a vida com pé direito e muito conforto. estamos super felizes por vocês três! contem com a gente sempre. ♡",
    giftLabel: "carrinho de bebê",
    valueCents: 65000,
    date: "23 mai",
    read: false,
  },
  {
    id: 4,
    name: "madrinha ju",
    message:
      "afilhado lindo, a dinda já te ama demais. esse é só o primeiro de muitos mimos, viu?",
    giftLabel: "mobile musical",
    valueCents: 9000,
    date: "21 mai",
    read: true,
  },
  {
    id: 5,
    name: "priscila do trabalho",
    message:
      "helena, parabéns pela novidade mais linda! que ele venha com muita saúde. um beijo carinhoso da equipe toda.",
    giftLabel: "kit higiene",
    valueCents: 7500,
    date: "20 mai",
    read: true,
  },
  {
    id: 6,
    name: "tio marcos",
    message:
      "bem-vindo ao mundo, campeão! o titio já separou a primeira camisa do time pra você. saúde e alegria sempre.",
    giftLabel: "macacão + meinhas",
    valueCents: 8500,
    date: "19 mai",
    read: true,
  },
  {
    id: 7,
    name: "ana paula",
    message:
      "feito com muito carinho pra esse momento tão especial de vocês. que a chegada dele seja cheia de luz. ♡",
    giftLabel: "fralda ecológica (kit)",
    valueCents: 14000,
    date: "18 mai",
    read: true,
  },
  {
    id: 8,
    name: "primos da bahia",
    message:
      "de longe, mas com o coração pertinho! mal podemos esperar pra conhecer o mais novo membro da família. um abraço apertado.",
    giftLabel: "banheira + suporte",
    valueCents: 22000,
    date: "16 mai",
    read: true,
  },
  {
    id: 9,
    name: "dona neusa (vizinha)",
    message:
      "que esse bebê chegue trazendo só paz e sorrisos pra casa de vocês. um carinho da vizinha de sempre.",
    giftLabel: "manta de algodão",
    valueCents: 6000,
    date: "14 mai",
    read: true,
  },
  {
    id: 10,
    name: "lucas e a bia",
    message:
      "pra noites mais tranquilas e muitos cafunés. estamos torcendo muito por vocês! ♡",
    giftLabel: "kit sono (ninho + naninha)",
    valueCents: 18000,
    date: "12 mai",
    read: true,
  },
];

/** R$ formatter from cents — matches the pt-BR money style used elsewhere. */
export function fmtValue(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

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
  return AVATAR_PALETTES[h % AVATAR_PALETTES.length] ?? AVATAR_PALETTES[0]!;
}

export function initialsOf(name: string): string {
  const parts = name
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
}
