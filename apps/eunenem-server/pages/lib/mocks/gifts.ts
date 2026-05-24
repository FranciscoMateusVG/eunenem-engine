// aperture-3d9t — gift list mock data.
//
// Each gift entry matches the visual design in `reference/marketplace.jsx`.
// `status: "presenteado"` rows show up as taken in the UI even on first
// load — useful for demonstrating the "já presenteado ♡" affordance.
// All bg colours reference EuNeném tokens (Visual Identity Prompt §2).

export type GiftCategory =
  | "Mamadeiras"
  | "Banho"
  | "Quartinho"
  | "Sono"
  | "Passeio"
  | "Fralda"
  | "Brincar"
  | "Saúde";

export type GiftStatus = "available" | "presenteado";

export interface Gift {
  id: string;
  category: GiftCategory;
  name: string;
  description: string;
  priceBRL: number;
  emoji: string;
  bgColor: string;
  status: GiftStatus;
}

export const GIFT_CATEGORIES: ("Todos" | GiftCategory)[] = [
  "Todos",
  "Mamadeiras",
  "Banho",
  "Quartinho",
  "Sono",
  "Passeio",
  "Fralda",
  "Brincar",
  "Saúde",
];

export const GIFTS: Gift[] = [
  {
    id: "g1",
    category: "Mamadeiras",
    name: "Kit mamadeiras",
    description:
      "Kit com 3 mamadeiras anticólica, do tamanho recém-nascido ao 6m.",
    priceBRL: 120,
    emoji: "🍼",
    bgColor: "var(--pink-soft)",
    status: "available",
  },
  {
    id: "g2",
    category: "Banho",
    name: "Banheira & banho",
    description:
      "Banheira ergonômica, termômetro e os primeiros saboninhos.",
    priceBRL: 240,
    emoji: "👶",
    bgColor: "var(--blue)",
    status: "presenteado",
  },
  {
    id: "g3",
    category: "Quartinho",
    name: "Bichinho de pelúcia",
    description: "Aquele bicho mole, neutro, pra dormir agarradinho.",
    priceBRL: 85,
    emoji: "🧸",
    bgColor: "var(--lilac-soft)",
    status: "available",
  },
  {
    id: "g4",
    category: "Sono",
    name: "Berço de madeira",
    description: "Berço de madeira clarinha que a gente escolheu junto.",
    priceBRL: 180,
    emoji: "🛏️",
    bgColor: "var(--pink-soft)",
    status: "available",
  },
  {
    id: "g5",
    category: "Passeio",
    name: "Carrinho 3 em 1",
    description:
      "Carrinho pra passear no parque desde os primeiros meses.",
    priceBRL: 250,
    emoji: "🚼",
    bgColor: "var(--cream-2)",
    status: "available",
  },
  {
    id: "g6",
    category: "Fralda",
    name: "Pacotão de fraldas",
    description:
      "Estoque de fralda pro primeiro mês inteiro — o presente que salva.",
    priceBRL: 60,
    emoji: "🧷",
    bgColor: "var(--green)",
    status: "presenteado",
  },
  {
    id: "g7",
    category: "Brincar",
    name: "Primeiros livrinhos",
    description:
      "Coleção de livros de pano e cartonado pra ler antes de dormir.",
    priceBRL: 95,
    emoji: "📖",
    bgColor: "var(--yellow)",
    status: "available",
  },
  {
    id: "g8",
    category: "Saúde",
    name: "Kit higiene",
    description:
      "Aspirador nasal, termômetro digital e cortador de unha de bebê.",
    priceBRL: 70,
    emoji: "🩺",
    bgColor: "var(--lilac-soft)",
    status: "available",
  },
];
