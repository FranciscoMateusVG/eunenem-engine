// Plan 0017 / aperture-16flf — visitor cart state for the public
// `/pagina/<slug>` marketplace. React Context + useReducer + localStorage
// persistence. No external state library — Context is enough for an MVP
// scoped to one section's worth of state.
//
// Cart-scope invariant (Plan 0016 locked decision #8): all items in one
// cart share the same `idCampanha`. The visitor doesn't know the
// campanha id directly but the slug 1:1 maps to one campanha server-side,
// so we key the localStorage entry by slug. Visiting a different `/pagina/X`
// loads the cart-for-X (empty if none) and Y's cart sits untouched.
//
// Cart line shape: each line corresponds to one VisitorGift group (rows
// sharing a `nome`). The line captures every available `idContribuicao`
// the group offered at add-time + the visitor's chosen `quantidade`.
//
// Why capture all available ids: today's wire returns N flat rows per
// "gift" (legacy pre-0016 shape — see aperture-1l37i for the planned
// create-flow rewrite). To express "Fralda × 3", we need to send THREE
// items at saga time, each with quantidade=1, each pointing at a distinct
// row-id. Capturing the available-id list at add-time lets the cart
// faithfully build the saga input without re-querying.
//
// When Rex's create-flow rewrite lands (aperture-1l37i) the visitor wire
// will return 1 row per gift with quantidade=N. At that point a cart line
// collapses to a single saga item `{idContribuicao, quantidade: N}` — but
// the line shape AND the public API of this module don't need to change,
// only the `toSagaInput` mapping below.

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
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
  /** Snapshot of contribuição row-ids available when the line was first added. */
  idsAvailable: readonly string[];
  /** Visitor's chosen quantity. Always 1 ≤ quantidade ≤ idsAvailable.length. */
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
  | { type: 'clear' }
  | { type: 'hydrate'; state: CartState };

// ── Reducer ────────────────────────────────────────────────────────────────

function reducer(state: CartState, action: Action): CartState {
  switch (action.type) {
    case 'add': {
      const existing = state.lines.find((l) => l.nome === action.gift.nome);
      if (existing) {
        // Adding when already in cart bumps quantidade by 1, capped at
        // idsAvailable.length (visitor can't add more than the marketplace
        // surfaces). Esgotada races still possible at saga time; the cap
        // here is just the UI's honest read.
        if (existing.quantidade >= existing.idsAvailable.length) return state;
        return {
          ...state,
          lines: state.lines.map((l) =>
            l.nome === action.gift.nome ? { ...l, quantidade: l.quantidade + 1 } : l,
          ),
        };
      }
      // First add — capture all available ids + initial quantidade=1.
      // Filter ids to the subset the wire flagged available (the group's
      // `ids` includes presenteado ones; we only want the buyable ones).
      const idsAvailable = action.gift.ids.filter(
        (_, i) => i < action.gift.qtyAvailable,
      );
      if (idsAvailable.length === 0) return state;
      const line: CartLine = {
        nome: action.gift.nome,
        idsAvailable,
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
          l.nome === action.nome && l.quantidade < l.idsAvailable.length
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
    case 'hydrate': {
      return action.state;
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

// localStorage key — namespaced so multiple browser tabs on different
// slugs don't collide. Hydration is lazy + defensive (silently ignores
// malformed or wrong-slug payloads).
function storageKey(slug: string): string {
  return `eunenem.cart.v1.${slug}`;
}

interface CartProviderProps {
  slug: string;
  children: ReactNode;
}

export function CartProvider({ slug, children }: CartProviderProps) {
  const [state, dispatch] = useReducer(reducer, { slug, lines: [] } as CartState);

  // One-time hydrate from localStorage on mount (and whenever the slug
  // changes — visiting another `/pagina/X` triggers a re-mount via the
  // PaginaPage key, but we defensively re-hydrate here too).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(storageKey(slug));
      if (!raw) {
        dispatch({ type: 'hydrate', state: { slug, lines: [] } });
        return;
      }
      const parsed = JSON.parse(raw) as CartState | null;
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.slug === slug &&
        Array.isArray(parsed.lines)
      ) {
        dispatch({ type: 'hydrate', state: parsed });
      }
    } catch {
      // Malformed payload — ignore + start fresh. The cart is recoverable
      // via re-adding; we don't surface a UI error for a parser miss.
    }
  }, [slug]);

  // Persist on every state change (cheap: cart is small).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey(slug), JSON.stringify(state));
    } catch {
      // QuotaExceededError + private-browsing edge cases — silently skip.
    }
  }, [state, slug]);

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
        return line.idsAvailable.length - line.quantidade;
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
 * Today (legacy pre-0016 wire) we expand each multi-quantidade line into
 * N separate items with quantidade=1 each — one per available row-id the
 * group exposed. After aperture-1l37i lands and the visitor wire returns
 * 1 row + quantidade=N, this mapping collapses to one saga item per line.
 */
export function toSagaInput(
  lines: readonly CartLine[],
): ReadonlyArray<{ idContribuicao: string; quantidade: number }> {
  const itens: { idContribuicao: string; quantidade: number }[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.quantidade; i++) {
      const id = line.idsAvailable[i];
      if (!id) continue;
      itens.push({ idContribuicao: id, quantidade: 1 });
    }
  }
  return itens;
}
