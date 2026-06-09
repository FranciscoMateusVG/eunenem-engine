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
  /**
   * UNSOLD slot id(s) for the cart's saga input.
   *
   * LEGACY shape (multi-row, each row × quantidade=1) — populated by
   * `groupVisitorGifts` from rows with `status === "disponivel"` only.
   * Length equals `qtyAvailable`. The cart (lib/cart.tsx) captures these
   * at add-time so `toSagaInput` fans out into N items × quantidade=1,
   * one per row-id. (aperture-qxntg fix — never sends a sold-out id.)
   *
   * NEW-SHAPE (single row × quantidade=N — Plan 0016 post-create-flow):
   * single-entry list `[c.id]` even when N units remain. The cart's
   * cap reads `qtyAvailable` (not `availableIds.length`) and toSagaInput
   * detects the shape and emits ONE item × quantidade=N, letting the
   * saga pack the multiplicity onto a single ItemDoPagamento.
   *
   * Empty array when the whole group is taken (matches `availableId
   * === null`).
   *
   * aperture-nz12u dual-mode bake — pre-nz12u this field was implicitly
   * legacy-only and the new-shape gifts wrongly capped the cart at 1.
   */
  availableIds: string[];
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
  /** Raw Pix-method price in cents (backend canonical). Render with
   *  `formatBRL(valorCents)` for the display string — see
   *  pages/lib/formatBRL.ts. The legacy `priceBRL` integer-reais field
   *  was dropped in aperture-dikki because Math.round-to-int truncated
   *  the cents introduced by the fee-inclusive projection (aperture-ines9). */
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
    const isAvailable = c.status === "disponivel";
    // aperture-nz12u DUAL-MODE — distinguish new-shape (single row,
    // c.quantidade > 1) from legacy (N rows × c.quantidade=1). The
    // `> 1` discriminator is safe: legacy data has quantidade=1 by
    // migration 022's default; new-shape data is single-row by
    // construction (create-flow rewrite per Plan 0016).
    const isNewShape = c.quantidade > 1;
    // Clamp restante to ≥0 for the visitor UI cap. Overshoot
    // (locked decision #10) still surfaces as ESGOTADA via the
    // status === 'indisponivel' branch upstream; we don't let a
    // negative number leak into the cart's increment ceiling.
    const restanteClamped = Math.max(0, c.quantidadeRestante);

    if (existing) {
      // Legacy accumulation — another row sharing nome bumps counts.
      // For new-shape this branch shouldn't fire (one row per gift by
      // construction); if it does (defensive, e.g. operator-error
      // multi-write), the first row's qtyTotal stands and we just
      // append the id to the legacy availableIds list.
      existing.ids.push(c.id);
      if (!isNewShape) {
        existing.qtyTotal += 1;
        if (isAvailable) {
          existing.qtyAvailable += 1;
          // aperture-qxntg — push the row-id onto the unsold subset so
          // the cart's saga input only ever picks buyable ids.
          existing.availableIds.push(c.id);
          if (!existing.availableId) existing.availableId = c.id;
        }
      }
    } else {
      // aperture-kx9bl: `valorComTaxaCartao` was a parallel-prep field
      // (pre-m95f3). The cast is now a defensive no-op — RouterOutputs
      // carries it — kept against future schema drift.
      const valorComTaxa = (c as { valorComTaxaCartao?: number })
        .valorComTaxaCartao;
      map.set(c.nome, {
        ids: [c.id],
        availableId: isAvailable ? c.id : null,
        // NEW-SHAPE: single-entry availableIds even when N units remain.
        // The cart's toSagaInput detects this shape (idsAvailable.length
        // === 1 AND quantidade > 1) and emits ONE item × N, letting the
        // saga pack the multiplicity onto a single ItemDoPagamento.
        //
        // LEGACY: seeded single-entry here; the existing-branch above
        // appends subsequent unsold rows. toSagaInput fans out into N
        // items × 1 (one per row-id), preserving legacy semantics.
        availableIds: isAvailable ? [c.id] : [],
        nome: c.nome,
        displayCategory: humaniseGrupo(c.grupo),
        grupoKey: c.grupo ?? "Outros",
        imagemUrl: c.imagemUrl,
        emoji: deriveEmoji(c.grupo),
        bgColor: deriveBgColor(c.grupo),
        valorCents: c.valor,
        valorComTaxaCartaoCents:
          typeof valorComTaxa === "number" ? valorComTaxa : null,
        // aperture-nz12u DUAL-MODE: new-shape reads c.quantidade /
        // c.quantidadeRestante; legacy seeds 1 / (isAvailable?1:0) and
        // gets accumulated by the existing-branch above.
        qtyTotal: isNewShape ? c.quantidade : 1,
        qtyAvailable: isNewShape
          ? restanteClamped
          : isAvailable
            ? 1
            : 0,
        status: (isNewShape ? restanteClamped > 0 : isAvailable)
          ? "available"
          : "presenteado",
      });
    }
  }
  // Final pass: refresh status from final qtyAvailable. New-shape
  // entries already have the correct status from the seed branch (one
  // row, one pass); legacy entries need this re-derivation after row
  // accumulation.
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
