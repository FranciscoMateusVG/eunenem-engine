// aperture-4je0p — mock data for /painel/[slug]/lista (Minha lista de
// presentes — creator gift-list management).
//
// aperture-cwcn0 — Catalog data extracted to git-versioned JSON in
// `apps/eunenem-server/lib/seed-data/catalog.json` and exposed via
// the typed loader in `apps/eunenem-server/lib/templates`. This file
// keeps:
//   - the per-user demo seed (LISTA_PRESENTES_SEED — still a mock
//     because the real data lives in tRPC `contribuicao` rows once
//     aperture-0ph83 lands)
//   - the UI vocabulary (LISTA_CATEGORY_LABEL — pt-BR labels for the
//     category chips/badges, kept in code per operator decision)
// …and re-exports the data shapes + catalog content from the loader
// so legacy callers (`ListaPresentesBody.tsx`, future tRPC mappers,
// etc.) keep their existing import surface working.
//
// Visual language follows the "Lista de Presentes" export (Patrick Hand
// titles, lilás thumbs, plum shadows) adapted to the 520px painel shell.

import {
  loadCatalog,
  type ListaCatalogItem,
  type ListaCatalogSection,
  type ListaCategory,
} from "../../../lib/templates";

// Re-export the canonical types + the loaded catalog so existing
// imports (`import { LISTA_CATALOGO_SEED, ListaCategory } from
// '@/lib/mocks/listaPresentes'`) keep resolving without touching
// any caller. The loader is the source of truth — this file is the
// compat seam.
export type { ListaCategory, ListaCatalogItem, ListaCatalogSection };

/** Catalog seed surfaced through the JSON loader. Frozen reference;
 *  do NOT mutate (the loader hands back a module-level snapshot). */
export const LISTA_CATALOGO_SEED: ListaCatalogSection[] = loadCatalog();

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

/** pt-BR display labels for the category chips/badges. UI vocabulary,
 *  kept in code (operator decision; per aperture-cwcn0). */
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
 *  sprite the standalone export used). Stays a mock — becomes real
 *  contribuicoes in aperture-0ph83. */
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
