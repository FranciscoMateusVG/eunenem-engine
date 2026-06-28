// aperture-neiwx (29kho-C) — PT-BR gender agreement helper.
//
// Single source of truth for how the baby's `genero` inflects copy, so the
// OWNER painel and the GUEST page never disagree (the bug: guest rendered
// "do {nome}" while the owner rendered "da {nome}"). Both surfaces now read the
// same `genero` field (Rex's ConteudoPerfilCriador) and run it through here.
//
// `genero` is nullable on the backend (existing rows = null) and the public
// query type may lag the backend — so every function takes `string | null |
// undefined` and treats anything unknown as the neutral case.

export type Genero = "menino" | "menina" | "neutro" | "surpresa";

/**
 * Possessive contraction placed before the baby's name:
 *   "lista {artigo} {nome}" → "lista do Pedro" / "lista da Luciana" / "lista de Alex".
 *
 * The article agrees with the BABY'S NAME, which is grammatically correct and
 * is the actual bug the operator reported. neutro / surpresa / null all use the
 * articleless "de" — valid for any gender and the right choice when the sex is
 * a surprise.
 */
export function artigoPosse(genero?: string | null): "do" | "da" | "de" {
  if (genero === "menino") return "do";
  if (genero === "menina") return "da";
  return "de";
}

/**
 * Definite article before the baby's name used as a subject:
 *   "Como {artigo} {nome} chegou" → "Como o Pedro chegou" / "Como a Luciana
 *   chegou" / "Como Alex chegou" (Story.tsx — "a nossa história" heading).
 *
 * neutro / surpresa / null return "" — the name stands alone, which is the
 * cleanest neutral PT-BR ("Como Alex chegou na nossa vida"). Callers must drop
 * the trailing space when this returns "" (render the article + space only when
 * truthy) to avoid a double space.
 */
export function artigoDefinido(genero?: string | null): "o" | "a" | "" {
  if (genero === "menino") return "o";
  if (genero === "menina") return "a";
  return "";
}

/**
 * Welcome word on the guest page. Addressed to the (unknown-gender) GUEST, not
 * the baby — so the grammatically-correct default is the neutral "Boas-vindas"
 * ("Boas-vindas à lista da Luciana"), which also covers neutro/surpresa with no
 * special case. Operator-gated: if a baby-themed gendered welcome is preferred,
 * swap ONLY this function body to return Bem-vindo / Bem-vinda / Boas-vindas.
 */
export function saudacao(_genero?: string | null): string {
  return "Boas-vindas";
}
