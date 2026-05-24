// aperture-3d9t — mural messages mock data.
//
// Six initial messages from the Claude Design reference
// (reference/messages.jsx). The `style: 'caveat'` ones render in
// Caveat italic with quote marks; `style: 'plain'` render in DM Sans.
// `avatarBg` references the EuNeném token palette.

export type MessageStyle = "caveat" | "plain";

export interface MuralMessage {
  id: string;
  authorName: string;
  avatarBg: string;
  avatarInitials: string;
  timeAgo: string;
  message: string;
  style: MessageStyle;
  /** Decorative rotation in degrees (-3 to 3). */
  rotation: number;
}

export const INITIAL_MESSAGES: MuralMessage[] = [
  {
    id: "m1",
    authorName: "Beatriz Camargo",
    avatarBg: "var(--coral-pink)",
    avatarInitials: "BC",
    timeAgo: "há 2 horas",
    message:
      "Que alegria saber que você tá vindo, Francisco! Já tô doida pra te encher de beijo. ♡",
    style: "caveat",
    rotation: -1.5,
  },
  {
    id: "m2",
    authorName: "Tia Helena",
    avatarBg: "var(--lilac-deep)",
    avatarInitials: "TH",
    timeAgo: "há 5 horas",
    message:
      "Mari e Rodrigo, vocês vão ser pais incríveis. O Francisco já é amado por tanta gente — eu sou só mais uma na fila. Beijos com saudade da titia.",
    style: "plain",
    rotation: 1.5,
  },
  {
    id: "m3",
    authorName: "Pedro & Luana",
    avatarBg: "var(--green)",
    avatarInitials: "PL",
    timeAgo: "ontem",
    message:
      "vai chegar cheio de amor, primo! a gente já tá preparando a primeira festa de aniversário ✨",
    style: "caveat",
    rotation: -2,
  },
  {
    id: "m4",
    authorName: "Vovó Cida",
    avatarBg: "var(--coral-pink)",
    avatarInitials: "VC",
    timeAgo: "ontem",
    message:
      "Meu netinho querido, a vovó já tá tricotando uma manta azul-bebê pra você. Espero teu cheirinho. Beijo grande.",
    style: "plain",
    rotation: 2,
  },
  {
    id: "m5",
    authorName: "Time Acme",
    avatarBg: "var(--lilac)",
    avatarInitials: "TA",
    timeAgo: "há 2 dias",
    message:
      "Mari, parabéns!! O time todo tá enviando esse abraço apertado pra família crescer ainda mais. ♡",
    style: "caveat",
    rotation: -1,
  },
  {
    id: "m6",
    authorName: "Carol",
    avatarBg: "var(--blue)",
    avatarInitials: "C",
    timeAgo: "há 3 dias",
    message:
      "Que momento mais lindo. Já não vejo a hora de ver vocês três juntos. Conta com a tia Carol pra qualquer babá-de-emergência ;)",
    style: "plain",
    rotation: 1,
  },
];
