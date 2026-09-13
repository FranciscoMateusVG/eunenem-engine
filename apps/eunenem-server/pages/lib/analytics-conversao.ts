// aperture-wdis6 — ONE monetary conversion per payment.
//
// `compra_concluida` used to be fired raw from five UI sites (the /sucesso
// ApprovedState mount, and the inline Stripe-approved / PIX-confirmed paths
// of CartDrawer + GiftCheckoutModal). Each site was only guarded by React
// state (mount / phase), so a reload, a back-navigation or an alternate
// success surface for the SAME payment re-emitted the conversion — and no
// site carried a payment id, so GA4 (and Mixpanel) could not dedupe it
// either. This module is the single funnel every site goes through:
//
//   1. props are built ONCE, in the shape both sinks agreed on (GA4 needs
//      `value` decimal + `currency`; Mixpanel keeps `valor_centavos` parity
//      with checkout_iniciado; `transaction_id` is the durable payment id —
//      Stripe checkout session id or Inter PIX txid — that GA4 dedupes on
//      and that Wheatley's Mixpanel contract maps to $insert_id inside
//      analytics.ts). No `$`-prefixed keys here: GA4 drops/mangles them.
//   2. the dedupe happens BEFORE sendEvent(), so BOTH sinks see exactly one
//      compra_concluida per transaction_id — keyed in localStorage so it
//      survives reload and alternate surfaces, with an in-memory fallback
//      when storage is unavailable (Safari private mode throws on access).
//
// The emitter and the registry are injectable so the contract is provable in
// a pure node unit test (tests/unit/server/wdis6-compra-concluida.test.ts)
// without a DOM.
import { sendEvent } from './analytics.js';
import type { MetodoPagamento } from './paginaApi.js';

export const EVENTO_COMPRA_CONCLUIDA = 'compra_concluida';

/** Same enum checkout_iniciado already sends (`'pix' | 'credit_card'`, pagina-router). */
export type MetodoCompra = MetodoPagamento;

export interface CompraConcluidaInput {
  /** Durable payment id: Stripe checkout session id (credit_card) or Inter txid (pix). */
  transactionId: string;
  valorCentavos: number;
  metodo: MetodoCompra;
  giftName: string;
  /** Omitted when the surface does not know it (the /sucesso page today). */
  quantidadeItens?: number;
}

export interface CompraConcluidaProps {
  transaction_id: string;
  /** Decimal BRL — the shape GA4 attributes revenue on (with `currency`). */
  value: number;
  currency: 'BRL';
  /** Integer centavos — parity with checkout_iniciado.valor_centavos. */
  valor_centavos: number;
  /** Pre-wdis6 param name (centavos). Kept so any GA4 custom metric already
   *  registered on `valor` keeps flowing; identical to valor_centavos. */
  valor: number;
  metodo: MetodoCompra;
  gift_name: string;
  quantidade_itens?: number;
}

export function montarPropsCompraConcluida(input: CompraConcluidaInput): CompraConcluidaProps {
  const centavos = Math.round(input.valorCentavos);
  const props: CompraConcluidaProps = {
    transaction_id: input.transactionId,
    value: centavos / 100,
    currency: 'BRL',
    valor_centavos: centavos,
    valor: centavos,
    metodo: input.metodo,
    gift_name: input.giftName,
  };
  if (input.quantidadeItens !== undefined) props.quantidade_itens = input.quantidadeItens;
  return props;
}

// ── Dedupe registry ───────────────────────────────────────────────────────

export interface RegistroConversao {
  /** True when this transaction was already emitted from this browser. */
  jaEmitida(transactionId: string): boolean;
  marcarEmitida(transactionId: string): void;
}

/** Minimal Storage surface (localStorage-compatible) so tests can pass a Map. */
export interface ArmazenamentoConversao {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CHAVE_PREFIXO = 'eunenem:conv:compra:';

/**
 * Registry backed by `armazenamento` (localStorage in the browser), falling
 * back to an in-memory Set for the lifetime of the page whenever storage is
 * missing or throws. Every access is guarded: a storage failure must never
 * break the success screen — worst case we degrade to per-page dedupe.
 */
export function criarRegistroConversao(
  armazenamento: ArmazenamentoConversao | null | undefined,
): RegistroConversao {
  const memoria = new Set<string>();
  return {
    jaEmitida(transactionId) {
      if (memoria.has(transactionId)) return true;
      if (!armazenamento) return false;
      try {
        return armazenamento.getItem(CHAVE_PREFIXO + transactionId) !== null;
      } catch {
        return false;
      }
    },
    marcarEmitida(transactionId) {
      memoria.add(transactionId);
      if (!armazenamento) return;
      try {
        armazenamento.setItem(CHAVE_PREFIXO + transactionId, String(Date.now()));
      } catch {
        // storage unavailable — memory fallback already recorded it.
      }
    },
  };
}

function armazenamentoDoNavegador(): ArmazenamentoConversao | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null; // Safari private mode / disabled storage throws on access.
  }
}

// Module-level default: one registry per page lifetime, on top of localStorage.
let registroPadrao: RegistroConversao | null = null;
function registroDoNavegador(): RegistroConversao {
  if (!registroPadrao) registroPadrao = criarRegistroConversao(armazenamentoDoNavegador());
  return registroPadrao;
}

export interface RegistrarCompraDeps {
  registro?: RegistroConversao;
  emitir?: (eventName: string, props: Record<string, unknown>) => void;
}

/**
 * The ONE entry point for the purchase conversion. Returns true when the
 * event was emitted, false when this transaction was already counted.
 * Empty transactionId → emitted WITHOUT dedupe (never silently drop a real
 * conversion; the id gap surfaces as a missing transaction_id in reports).
 */
export function registrarCompraConcluida(
  input: CompraConcluidaInput,
  deps: RegistrarCompraDeps = {},
): boolean {
  const registro = deps.registro ?? registroDoNavegador();
  const emitir = deps.emitir ?? sendEvent;
  const props = montarPropsCompraConcluida(input);
  const id = input.transactionId.trim();
  if (id) {
    if (registro.jaEmitida(id)) return false;
    registro.marcarEmitida(id);
  }
  emitir(EVENTO_COMPRA_CONCLUIDA, { ...props });
  return true;
}
