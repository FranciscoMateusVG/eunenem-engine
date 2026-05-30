// aperture-4je0p — mock data for /painel/[slug]/lista (Minha lista de
// presentes — creator gift-list management).
//
// In-memory, no persistence. This is the CREATOR side of the gift list:
// each item carries a price, a desired quantity (qty) and how many units
// have already been claimed by guests (received). The public buy view
// (Marketplace.tsx + gifts.ts) is a separate, simpler shape — this one
// adds qty/received so the creator can manage stock and see progress.
//
// Visual language follows the "Lista de Presentes" export (Patrick Hand
// titles, lilás thumbs, plum shadows) adapted to the 520px painel shell.

/** Category tag shown on each gift card. Lowercased in the UI. */
export type ListaCategory =
  | "fraldas"
  | "higiene"
  | "roupa"
  | "soninho"
  | "alimentacao"
  | "passeio"
  | "personalizado";

export interface ListaGift {
  id: string;
  /** Display name ("Pacote de Fraldas RN"). */
  title: string;
  /** Price per unit, in BRL (so 49.9 → R$ 49,90). */
  price: number;
  /** Desired quantity (how many of this the creator wants). */
  qty: number;
  /** Units already claimed/gifted by guests. */
  received: number;
  category: ListaCategory;
  /** Emoji glyph rendered in the card thumb. */
  emoji: string;
  /** Token-referencing tint for the thumb background. */
  bgColor: string;
  /** Whether this is a creator-authored custom item (not from catalog). */
  custom?: boolean;
}

/** pt-BR display labels for the category chips/badges. */
export const LISTA_CATEGORY_LABEL: Record<ListaCategory, string> = {
  fraldas: "fraldas",
  higiene: "higiene",
  roupa: "roupinhas",
  soninho: "soninho",
  alimentacao: "alimentação",
  passeio: "passeio",
  personalizado: "personalizado",
};

/** Seed list for the "Helena" demo. Mirrors the export's SEED_ITEMS but
 *  with emoji glyphs + token tints (the painel doesn't ship the SVG
 *  sprite the standalone export used). */
export const LISTA_PRESENTES_SEED: ListaGift[] = [
  {
    id: "a1",
    title: "Pacote de Fraldas RN",
    price: 49.9,
    qty: 8,
    received: 3,
    category: "fraldas",
    emoji: "🧷",
    bgColor: "var(--lilac-soft)",
  },
  {
    id: "a2",
    title: "Pacote de Fraldas P",
    price: 54.9,
    qty: 6,
    received: 2,
    category: "fraldas",
    emoji: "🧷",
    bgColor: "var(--lilac-soft)",
  },
  {
    id: "a3",
    title: "Lenço Umedecido (kit 3)",
    price: 38.5,
    qty: 4,
    received: 4,
    category: "higiene",
    emoji: "🧻",
    bgColor: "var(--pink-soft)",
  },
  {
    id: "a4",
    title: "Pomada para Assaduras",
    price: 42.0,
    qty: 2,
    received: 1,
    category: "higiene",
    emoji: "🧴",
    bgColor: "#eef4d1",
  },
  {
    id: "a5",
    title: "Body Manga Longa (kit 3)",
    price: 89.0,
    qty: 3,
    received: 1,
    category: "roupa",
    emoji: "👕",
    bgColor: "var(--pink-soft)",
  },
  {
    id: "a6",
    title: "Mantinha de Algodão",
    price: 92.0,
    qty: 1,
    received: 0,
    category: "soninho",
    emoji: "🧸",
    bgColor: "var(--lilac-soft)",
  },
  {
    id: "a7",
    title: "Mamadeira Anticólica",
    price: 58.0,
    qty: 2,
    received: 0,
    category: "alimentacao",
    emoji: "🍼",
    bgColor: "var(--blue)",
  },
  {
    id: "a8",
    title: "Cadeirinha de Carro Maxi-Cosi",
    price: 199.0,
    qty: 1,
    received: 0,
    category: "personalizado",
    emoji: "🚼",
    bgColor: "var(--cream-2)",
    custom: true,
  },
];

// =================================================================
// aperture-17cls — catalog mock for the "Adicionar à minha lista"
// modal's CATÁLOGO tab. Same shape as ListaGift minus the runtime
// fields (received, qty are SUGGESTIONS the form lets the creator
// override; received only exists once the item is on a creator's
// actual list). Operator will swap this for real catalog data
// later — keeping the seed compact + emoji-only so it's easy to
// re-author and so a Brazilian creator instantly recognises each
// item without product photography.
// =================================================================

export interface ListaCatalogItem {
  id: string;
  /** Display name shown on the card. */
  name: string;
  /** Suggested unit price in BRL. The creator can override. */
  price: number;
  /** Default qty the form pre-fills when the item is added. */
  suggestedQty: number;
  /** Emoji glyph for the card thumb. */
  emoji: string;
  /** Token-referencing tint for the thumb background. */
  bgColor: string;
  /** Category — used for the section header + (when added) the
   *  resulting ListaGift's category field. */
  category: ListaCategory;
}

export interface ListaCatalogSection {
  /** Same enum as ListaCategory — section headers use the LABEL map. */
  category: ListaCategory;
  /** Pre-resolved display label (e.g. "fraldas", "roupinhas"). */
  label: string;
  /** Items in this section. */
  items: ListaCatalogItem[];
}

/**
 * Compact catalog seed, ~30 items across 6 categories. Tints rotate
 * through the four pastel tokens so adjacent cards never share a
 * thumb colour. Prices are pt-BR realistic mid-2026 (Mercado Livre
 * + Amazon BR average for the category).
 */
export const LISTA_CATALOGO_SEED: ListaCatalogSection[] = [
  {
    category: "fraldas",
    label: LISTA_CATEGORY_LABEL.fraldas,
    items: [
      { id: "c-fr-1", name: "Pacote de Fraldas RN", price: 49.9, suggestedQty: 6, emoji: "🧷", bgColor: "var(--lilac-soft)", category: "fraldas" },
      { id: "c-fr-2", name: "Pacote de Fraldas P", price: 54.9, suggestedQty: 6, emoji: "🧷", bgColor: "var(--cream-2)", category: "fraldas" },
      { id: "c-fr-3", name: "Pacote de Fraldas M", price: 59.9, suggestedQty: 4, emoji: "🧷", bgColor: "var(--peach-soft)", category: "fraldas" },
      { id: "c-fr-4", name: "Lenço Umedecido (kit 3)", price: 38.5, suggestedQty: 3, emoji: "🧻", bgColor: "var(--mint-soft)", category: "fraldas" },
    ],
  },
  {
    category: "higiene",
    label: LISTA_CATEGORY_LABEL.higiene,
    items: [
      { id: "c-hi-1", name: "Pomada de Assadura", price: 32.0, suggestedQty: 2, emoji: "🧴", bgColor: "var(--cream-2)", category: "higiene" },
      { id: "c-hi-2", name: "Sabonete Líquido Suave", price: 28.9, suggestedQty: 2, emoji: "🧼", bgColor: "var(--lilac-soft)", category: "higiene" },
      { id: "c-hi-3", name: "Shampoo sem Lágrimas", price: 34.5, suggestedQty: 1, emoji: "🧴", bgColor: "var(--peach-soft)", category: "higiene" },
      { id: "c-hi-4", name: "Algodão Hidrófilo (500g)", price: 18.9, suggestedQty: 2, emoji: "☁️", bgColor: "var(--mint-soft)", category: "higiene" },
      { id: "c-hi-5", name: "Cortador de Unha Bebê", price: 22.9, suggestedQty: 1, emoji: "✂️", bgColor: "var(--cream-2)", category: "higiene" },
    ],
  },
  {
    category: "roupa",
    label: LISTA_CATEGORY_LABEL.roupa,
    items: [
      { id: "c-ro-1", name: "Body Manga Curta (kit 5)", price: 89.0, suggestedQty: 3, emoji: "👕", bgColor: "var(--peach-soft)", category: "roupa" },
      { id: "c-ro-2", name: "Macacão de Plush", price: 79.9, suggestedQty: 2, emoji: "🧸", bgColor: "var(--lilac-soft)", category: "roupa" },
      { id: "c-ro-3", name: "Mijão Algodão (kit 4)", price: 64.9, suggestedQty: 3, emoji: "👖", bgColor: "var(--mint-soft)", category: "roupa" },
      { id: "c-ro-4", name: "Manta Soft", price: 89.9, suggestedQty: 2, emoji: "🪶", bgColor: "var(--cream-2)", category: "roupa" },
      { id: "c-ro-5", name: "Pijama Comprido (kit 2)", price: 99.0, suggestedQty: 2, emoji: "🌙", bgColor: "var(--peach-soft)", category: "roupa" },
    ],
  },
  {
    category: "soninho",
    label: LISTA_CATEGORY_LABEL.soninho,
    items: [
      { id: "c-so-1", name: "Ninho Redutor de Berço", price: 189.0, suggestedQty: 1, emoji: "🛌", bgColor: "var(--lilac-soft)", category: "soninho" },
      { id: "c-so-2", name: "Edredom de Berço", price: 159.0, suggestedQty: 1, emoji: "🛏️", bgColor: "var(--mint-soft)", category: "soninho" },
      { id: "c-so-3", name: "Móbile Musical", price: 129.0, suggestedQty: 1, emoji: "🎶", bgColor: "var(--peach-soft)", category: "soninho" },
      { id: "c-so-4", name: "Lençol de Berço (kit 2)", price: 79.9, suggestedQty: 2, emoji: "🌸", bgColor: "var(--cream-2)", category: "soninho" },
    ],
  },
  {
    category: "alimentacao",
    label: LISTA_CATEGORY_LABEL.alimentacao,
    items: [
      { id: "c-al-1", name: "Mamadeira Anticólica (kit 3)", price: 119.0, suggestedQty: 2, emoji: "🍼", bgColor: "var(--mint-soft)", category: "alimentacao" },
      { id: "c-al-2", name: "Chupeta de Silicone", price: 34.9, suggestedQty: 2, emoji: "🍭", bgColor: "var(--lilac-soft)", category: "alimentacao" },
      { id: "c-al-3", name: "Babador Bandana (kit 6)", price: 49.9, suggestedQty: 2, emoji: "🌼", bgColor: "var(--peach-soft)", category: "alimentacao" },
      { id: "c-al-4", name: "Esterilizador de Mamadeira", price: 249.0, suggestedQty: 1, emoji: "♨️", bgColor: "var(--cream-2)", category: "alimentacao" },
    ],
  },
  {
    category: "passeio",
    label: LISTA_CATEGORY_LABEL.passeio,
    items: [
      { id: "c-pa-1", name: "Bebê Conforto", price: 599.0, suggestedQty: 1, emoji: "🚗", bgColor: "var(--peach-soft)", category: "passeio" },
      { id: "c-pa-2", name: "Mochila Canguru", price: 349.0, suggestedQty: 1, emoji: "🎒", bgColor: "var(--lilac-soft)", category: "passeio" },
      { id: "c-pa-3", name: "Saída de Maternidade", price: 189.0, suggestedQty: 1, emoji: "🎀", bgColor: "var(--cream-2)", category: "passeio" },
      { id: "c-pa-4", name: "Manta de Carrinho", price: 99.0, suggestedQty: 1, emoji: "🌷", bgColor: "var(--mint-soft)", category: "passeio" },
    ],
  },
];
