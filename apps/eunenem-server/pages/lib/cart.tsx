// Plan 0017 / aperture-16flf — visitor cart state for the public
// `/pagina/<slug>` marketplace. React Context + useReducer, IN-MEMORY ONLY.
// No external state library — Context is enough for an MVP scoped to one
// section's worth of state.
//
// aperture-90rab (operator decision) — NO persistence. The old
// localStorage bucket was keyed by USER slug, so two campanhas of the same
// account shared one cart (cross-campanha leak). Rather than re-key it,
// the cart resets on every page load: a guest picking gifts is a
// single-session flow, and no shared bucket = no leak, by construction.
//
// Cart-scope invariant (Plan 0016 locked decision #8): all items in one
// cart share the same `idCampanha` — trivially true now, since the cart
// lives and dies inside one page mount.
//
// Cart line shape: each line corresponds to one VisitorGift group (rows
// sharing a `nome`). The line captures the visitor's chosen `quantidade`
// + the slot's `qtyAvailable` ceiling (cart cap, source of truth) +
// the snapshot of `idsAvailable` row-ids (saga-input source).
//
// DUAL-MODE (aperture-nz12u): two data shapes flow through the same
// CartLine.
//   - LEGACY (multi-row, each row × quantidade=1): idsAvailable carries
//     N entries (one per unsold row-id); qtyAvailable === idsAvailable
//     .length. toSagaInput fans out into N items × quantidade=1, one
//     per row-id.
//   - NEW-SHAPE (single row × quantidade=N — Plan 0016 post-create-flow):
//     idsAvailable is single-entry [c.id]; qtyAvailable can be N. The
//     cart cap reads qtyAvailable. toSagaInput emits ONE item ×
//     quantidade=N, letting the saga pack the multiplicity onto a
//     single ItemDoPagamento.
//
// Pre-nz12u the cap was `idsAvailable.length` which was correct for
// legacy (where length === qtyAvailable) but wrong for new-shape (length
// always 1). Operator caught it on staging walk: Conjunto R$49,35 with
// quantidade=7 capped at +1. Fixed under dual-mode.

import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useReducer,
} from 'react';
import type { VisitorGift } from './visitorGift.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * One line in the cart. Mirrors the VisitorGift shape (so the drawer can
 * render thumbs + names + categories without re-deriving) PLUS the
 * visitor's chosen `quantidade` and the snapshot of available row-ids
 * captured at add-time.
 */
export interface CartLine {
  /** Stable key — the gift's display nome. Lines are 1:1 with VisitorGift groups. */
  nome: string;
  /**
   * Snapshot of contribuição row-ids the slot exposed at add-time.
   *
   * LEGACY: N entries (one per unsold row-id). toSagaInput fans out 1:1.
   * NEW-SHAPE: single-entry [c.id]. toSagaInput emits ONE item × quantidade.
   */
  idsAvailable: readonly string[];
  /**
   * Ceiling on the visitor's chosen quantidade — the slot's qtyAvailable
   * at add-time. Source of truth for the cart cap (aperture-nz12u dual-mode
   * fix). For legacy this happens to equal idsAvailable.length; for new-
   * shape it can exceed it (single id, N slots).
   */
  qtyAvailable: number;
  /** Visitor's chosen quantity. Always 1 ≤ quantidade ≤ qtyAvailable. */
  quantidade: number;
  valorCents: number;
  valorComTaxaCartaoCents: number | null;
  imagemUrl: string | null;
  emoji: string;
  bgColor: string;
  displayCategory: string;
  grupoKey: string;
}

interface CartState {
  /** Slug the cart belongs to. Cart resets when the page mounts under a different slug. */
  slug: string;
  lines: readonly CartLine[];
}

type Action =
  | { type: 'add'; gift: VisitorGift }
  | { type: 'increment'; nome: string }
  | { type: 'decrement'; nome: string }
  | { type: 'remove'; nome: string }
  | { type: 'clear' };

// ── Reducer ────────────────────────────────────────────────────────────────

function reducer(state: CartState, action: Action): CartState {
  switch (action.type) {
    case 'add': {
      const existing = state.lines.find((l) => l.nome === action.gift.nome);
      if (existing) {
        // aperture-nz12u — cap by qtyAvailable (works for both legacy
        // multi-row and new-shape single-row data). Pre-nz12u this
        // capped at idsAvailable.length which was correct for legacy
        // but wrong for new-shape (single id, N slots).
        if (existing.quantidade >= existing.qtyAvailable) return state;
        return {
          ...state,
          lines: state.lines.map((l) =>
            l.nome === action.gift.nome ? { ...l, quantidade: l.quantidade + 1 } : l,
          ),
        };
      }
      // aperture-qxntg — capture availableIds (UNSOLD rows only) from
      // the gift's projection. Pre-qxntg the slice picked from `gift.ids`
      // (every row sold + unsold) and could grab sold rows on legacy
      // data → saga's per-item esgotada gate fired 500.
      //
      // aperture-nz12u — the snapshot is the same single-id list for
      // new-shape data (one row × quantidade=N); the qtyAvailable
      // ceiling carries the multiplicity.
      const idsAvailable = action.gift.availableIds.slice();
      const qtyAvailable = action.gift.qtyAvailable;
      // Empty when the whole slot is taken. For new-shape this is also
      // when qtyAvailable === 0 (single id but zero remaining); guard on
      // qtyAvailable so the cart doesn't add a line that can't grow.
      if (idsAvailable.length === 0 || qtyAvailable === 0) return state;
      const line: CartLine = {
        nome: action.gift.nome,
        idsAvailable,
        qtyAvailable,
        quantidade: 1,
        valorCents: action.gift.valorCents,
        valorComTaxaCartaoCents: action.gift.valorComTaxaCartaoCents,
        imagemUrl: action.gift.imagemUrl,
        emoji: action.gift.emoji,
        bgColor: action.gift.bgColor,
        displayCategory: action.gift.displayCategory,
        grupoKey: action.gift.grupoKey,
      };
      return { ...state, lines: [...state.lines, line] };
    }
    case 'increment': {
      return {
        ...state,
        lines: state.lines.map((l) =>
          // aperture-nz12u — qtyAvailable cap (dual-mode safe).
          l.nome === action.nome && l.quantidade < l.qtyAvailable
            ? { ...l, quantidade: l.quantidade + 1 }
            : l,
        ),
      };
    }
    case 'decrement': {
      return {
        ...state,
        lines: state.lines
          .map((l) =>
            l.nome === action.nome ? { ...l, quantidade: l.quantidade - 1 } : l,
          )
          .filter((l) => l.quantidade > 0),
      };
    }
    case 'remove': {
      return { ...state, lines: state.lines.filter((l) => l.nome !== action.nome) };
    }
    case 'clear': {
      return { ...state, lines: [] };
    }
  }
}

// ── Context ────────────────────────────────────────────────────────────────

interface CartContextValue {
  state: CartState;
  add: (gift: VisitorGift) => void;
  increment: (nome: string) => void;
  decrement: (nome: string) => void;
  remove: (nome: string) => void;
  clear: () => void;
  /** Total units across all lines. Drives the badge on the cart button. */
  totalUnits: number;
  /** PIX-method cart total in cents (no surcharge). */
  totalPixCents: number;
  /** Cartão-method cart total in cents (includes Stripe surcharge per item). */
  totalCartaoCents: number;
  /** Helper: how many additional units of `nome` can still be added. */
  remainingFor: (nome: string) => number;
  /** Current quantity for a given nome (0 if not in cart). */
  quantidadeFor: (nome: string) => number;
}

const CartContext = createContext<CartContextValue | null>(null);

interface CartProviderProps {
  slug: string;
  children: ReactNode;
}

export function CartProvider({ slug, children }: CartProviderProps) {
  const [state, dispatch] = useReducer(reducer, { slug, lines: [] } as CartState);

  // aperture-90rab — in-memory only: no hydrate, no persist. Navigation or
  // refresh resets the cart (intentional; see header).

  const value = useMemo<CartContextValue>(() => {
    const totalUnits = state.lines.reduce((s, l) => s + l.quantidade, 0);
    const totalPixCents = state.lines.reduce(
      (s, l) => s + l.valorCents * l.quantidade,
      0,
    );
    const totalCartaoCents = state.lines.reduce(
      (s, l) => s + (l.valorComTaxaCartaoCents ?? l.valorCents) * l.quantidade,
      0,
    );
    return {
      state,
      add: (gift) => dispatch({ type: 'add', gift }),
      increment: (nome) => dispatch({ type: 'increment', nome }),
      decrement: (nome) => dispatch({ type: 'decrement', nome }),
      remove: (nome) => dispatch({ type: 'remove', nome }),
      clear: () => dispatch({ type: 'clear' }),
      totalUnits,
      totalPixCents,
      totalCartaoCents,
      remainingFor: (nome) => {
        const line = state.lines.find((l) => l.nome === nome);
        if (!line) return Infinity; // First add: cap comes from gift.qtyAvailable, not the cart.
        // aperture-nz12u — qtyAvailable, NOT idsAvailable.length. For
        // new-shape data the length is always 1 but the slot can have N
        // units remaining.
        return line.qtyAvailable - line.quantidade;
      },
      quantidadeFor: (nome) =>
        state.lines.find((l) => l.nome === nome)?.quantidade ?? 0,
    };
  }, [state]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error('useCart must be used inside <CartProvider>');
  }
  return ctx;
}

// ── Saga input mapping ─────────────────────────────────────────────────────

/**
 * Map the cart state to the `iniciarPagamentoCarrinho` saga input shape.
 *
 * DUAL-MODE (aperture-nz12u):
 *   - LEGACY line (idsAvailable.length >= quantidade): fan out into N
 *     items × quantidade=1, one per row-id. Legacy data is N rows of
 *     quantidade=1; the saga lands N separate ItemDoPagamento records.
 *   - NEW-SHAPE line (idsAvailable.length === 1 AND quantidade > 1):
 *     emit ONE item × quantidade=N against the single row-id. The
 *     saga packs the multiplicity onto a single ItemDoPagamento and
 *     the quantidadeRestante predicate consumes it as one slot-N count.
 *
 * The shape-discrimination is structural: if the cart's chosen quantidade
 * exceeds the snapshot's available-id count, we MUST be on new-shape data
 * (legacy would have one id per unit). Otherwise we walk the legacy path.
 * No mode flag needed on the line — the lengths tell us.
 */
export function toSagaInput(
  lines: readonly CartLine[],
): ReadonlyArray<{ idContribuicao: string; quantidade: number }> {
  const itens: { idContribuicao: string; quantidade: number }[] = [];
  for (const line of lines) {
    if (line.idsAvailable.length === 0) continue;
    if (line.quantidade <= line.idsAvailable.length) {
      // LEGACY (or new-shape with quantidade=1 — degenerate same shape):
      // fan out 1:1, one item per row-id.
      for (let i = 0; i < line.quantidade; i++) {
        const id = line.idsAvailable[i];
        if (!id) continue;
        itens.push({ idContribuicao: id, quantidade: 1 });
      }
    } else {
      // NEW-SHAPE — quantidade exceeds the snapshot's id count. The
      // contract from groupVisitorGifts is that new-shape lines have
      // exactly one id; assert defensively + emit a single item × N.
      const id = line.idsAvailable[0];
      if (!id) continue;
      itens.push({ idContribuicao: id, quantidade: line.quantidade });
    }
  }
  return itens;
}

