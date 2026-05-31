// aperture-3xgch — visitor-side mapping + grouping for the marketplace.
//
// Backend returns flat PaginaContribuicao[] (one row per unit). The visitor
// view wants one card per unique `nome` with aggregated qty/received counts
// (mirrors the painel pattern in ListaPresentesBody.tsx L242-270).
//
// The mapper layer also handles UI-only derivations the backend doesn't carry:
//   - bgColor (token name from grupo)
//   - emoji (fallback when imagemUrl is null)
//   - displayCategory (humanised grupo for chip + badge)
//   - displayPriceBRL (cents → BRL int for the card)

import type { PaginaContribuicao } from "./paginaApi.js";

/**
 * Shape consumed by GiftCard + Marketplace after mapping.
 * Status is derived: if at least one unit in the group is `disponivel`
 * → "available"; if all units are `indisponivel` → "presenteado".
 */
export interface VisitorGift {
  /** All contribuicao ids in the group — first available id is the one
   *  we send to iniciarPagamentoContribuicao when the visitor confirms. */
  ids: string[];
  /** The id of the first available unit; falsy if the whole group is taken. */
  availableId: string | null;
  nome: string;
  /** Humanised grupo or "Outros". Drives the chip + badge text. */
  displayCategory: string;
  /** Raw grupo string from backend (canonical key for filtering). */
  grupoKey: string;
  /** Image URL if the backend supplied one; null falls back to emoji. */
  imagemUrl: string | null;
  /** Emoji fallback when imagemUrl is null. Derived from grupo. */
  emoji: string;
  /** Background-color token (CSS var name) for the thumb square. */
  bgColor: string;
  /** Display price in BRL (integer reais — backend stores cents). */
  priceBRL: number;
  /** Raw Pix-method price in cents (backend canonical). */
  valorCents: number;
  /** Raw Cartão-method price in cents (valor + Stripe card surcharge),
   *  backend-computed (single source of truth, no client-side math).
   *  Null until aperture-m95f3 (Rex) lands the field on the router output. */
  valorComTaxaCartaoCents: number | null;
  /** Total units in the group. */
  qtyTotal: number;
  /** Units still available. */
  qtyAvailable: number;
  /** UI status — drives the CTA + badge. */
  status: "available" | "presenteado";
}

// ── Tables ────────────────────────────────────────────────────────────────

/** Background-color token per grupo (CSS var name). Falls back to lilac-soft
 *  for unknown groups — graceful default matching the painel side's
 *  deriveBgColor in contribuicao.ts. */
const GRUPO_BG_COLOR: Record<string, string> = {
  // Lowercase canonical (matches painel + DB lookups)
  fraldas: "var(--lilac-soft)",
  higiene: "var(--pink-soft)",
  roupa: "var(--pink-soft)",
  soninho: "var(--lilac-soft)",
  alimentacao: "var(--blue)",
  passeio: "var(--cream-2)",
  brinquedo: "var(--yellow)",
  outros: "var(--cream-2)",
  personalizado: "var(--lilac-soft)",
  // Title-case (matches the legacy mock categories — keep visual continuity
  // during the stub phase, drop these once Rex's lowercase canonical lands
  // and the seed data is consistent).
  Mamadeiras: "var(--pink-soft)",
  Banho: "var(--blue)",
  Quartinho: "var(--lilac-soft)",
  Sono: "var(--pink-soft)",
  Passeio: "var(--cream-2)",
  Fralda: "var(--green)",
  Brincar: "var(--yellow)",
  Saúde: "var(--lilac-soft)",
};

/** Emoji per grupo for when imagemUrl is null. Same fallback principle. */
const GRUPO_EMOJI: Record<string, string> = {
  fraldas: "🧷",
  higiene: "🩺",
  roupa: "👕",
  soninho: "🛏️",
  alimentacao: "🍼",
  passeio: "🚼",
  brinquedo: "🧸",
  outros: "🎁",
  personalizado: "✨",
  Mamadeiras: "🍼",
  Banho: "👶",
  Quartinho: "🧸",
  Sono: "🛏️",
  Passeio: "🚼",
  Fralda: "🧷",
  Brincar: "📖",
  Saúde: "🩺",
};

const HUMANISE: Record<string, string> = {
  fraldas: "Fralda",
  higiene: "Higiene",
  roupa: "Roupinha",
  soninho: "Sono",
  alimentacao: "Mamadeira",
  passeio: "Passeio",
  brinquedo: "Brincar",
  outros: "Outros",
  personalizado: "Personalizado",
};

// ── Derivations ───────────────────────────────────────────────────────────

export function deriveBgColor(grupo: string | null): string {
  if (grupo === null) return "var(--lilac-soft)";
  return GRUPO_BG_COLOR[grupo] ?? "var(--lilac-soft)";
}

export function deriveEmoji(grupo: string | null): string {
  if (grupo === null) return "🎁";
  return GRUPO_EMOJI[grupo] ?? "🎁";
}

export function humaniseGrupo(grupo: string | null): string {
  if (grupo === null) return "Outros";
  return HUMANISE[grupo] ?? grupo;
}

// ── Grouping ──────────────────────────────────────────────────────────────

/**
 * Group flat PaginaContribuicao[] by nome — one VisitorGift per unique item
 * shape. Mirrors the painel pattern. The first unit's grupo/imagemUrl wins
 * for the group's display fields (assumption: duplicates with the same nome
 * are identical except for status — that's how the painel writes them).
 */
export function groupVisitorGifts(items: PaginaContribuicao[]): VisitorGift[] {
  const map = new Map<string, VisitorGift>();
  for (const c of items) {
    const existing = map.get(c.nome);
    if (existing) {
      existing.ids.push(c.id);
      existing.qtyTotal += 1;
      if (c.status === "disponivel") {
        existing.qtyAvailable += 1;
        if (!existing.availableId) existing.availableId = c.id;
      }
    } else {
      const isAvailable = c.status === "disponivel";
      // aperture-kx9bl: `valorComTaxaCartao` is on Rex's m95f3-extended
      // PaginaContribuicao output. Until that branch is in flight against
      // staging, the inferred type doesn't carry the field. The cast
      // disappears when m95f3 lands and the RouterOutputs picks it up.
      const valorComTaxa = (c as { valorComTaxaCartao?: number })
        .valorComTaxaCartao;
      map.set(c.nome, {
        ids: [c.id],
        availableId: isAvailable ? c.id : null,
        nome: c.nome,
        displayCategory: humaniseGrupo(c.grupo),
        grupoKey: c.grupo ?? "Outros",
        imagemUrl: c.imagemUrl,
        emoji: deriveEmoji(c.grupo),
        bgColor: deriveBgColor(c.grupo),
        priceBRL: Math.round(c.valor / 100), // cents → BRL int
        valorCents: c.valor,
        valorComTaxaCartaoCents:
          typeof valorComTaxa === "number" ? valorComTaxa : null,
        qtyTotal: 1,
        qtyAvailable: isAvailable ? 1 : 0,
        status: isAvailable ? "available" : "presenteado",
      });
    }
  }
  for (const g of map.values()) {
    g.status = g.qtyAvailable > 0 ? "available" : "presenteado";
  }
  return [...map.values()];
}

/**
 * Derive the chip set from the visible gifts. "Todos" goes first; only
 * grupos that actually appear in the result set are surfaced (so the chip
 * bar reflects the listmaker's reality, not a fixed taxonomy).
 */
export function deriveCategoryChips(gifts: VisitorGift[]): string[] {
  const seen = new Set<string>();
  for (const g of gifts) seen.add(g.grupoKey);
  return ["Todos", ...[...seen].sort((a, b) => a.localeCompare(b, "pt-BR"))];
}
