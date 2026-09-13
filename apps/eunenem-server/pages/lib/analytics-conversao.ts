// aperture-wdis6 — compra_concluida: the CLIENT-SIDE purchase confirmation,
// emitted best-effort at most once per payment PER BROWSER.
//
// Semantics (root decision 2026-09-13, Izzy sdg24h HOLD): this is a UX
// confirmation event, not the financial truth. The server-side
// pagamento_aprovado (Wheatley, aperture-4yse9) is the approval event;
// reports must not add the two as separate purchases. What this module
// guarantees, and what it does NOT:
//
//   GUARANTEED (unit-tested, tests/unit/server/wdis6-compra-concluida.test.ts)
//   - one prop contract for both sinks (GA4 + Mixpanel via sendEvent):
//     transaction_id (Stripe checkout session id / Inter PIX txid), value
//     (BRL decimal) + currency, valor_centavos (+ legacy `valor`), metodo,
//     gift_name, quantidade_itens?. No `$`-prefixed keys (GA4 mangles them);
//     the Mixpanel $insert_id mapping lives in analytics.ts, not here.
//   - within ONE browser profile, a transaction_id is emitted at most once:
//     the check runs BEFORE sendEvent(), keyed in localStorage, so a reload,
//     back-navigation or the /sucesso escape hatch for the same payment does
//     not re-emit to either sink.
//   - no transaction_id → NOT emitted (a confirmation without identity is
//     not countable; the flow/UI is untouched, nothing sensitive is logged).
//
//   NOT GUARANTEED (documented limits, also unit-tested where possible)
//   - another browser / device / profile, or cleared site data, will emit the
//     same payment again — the registry is browser-local, not payment state.
//   - storage unavailable (Safari private mode, quota) degrades to
//     page-lifetime dedupe only.
//   - two tabs confirming the same payment at the same instant can both
//     emit: localStorage has no atomic check-and-set.
//   - GA4 does NOT deduplicate this custom event on transaction_id (that
//     documented behaviour applies to `purchase`); Mixpanel dedupes only if
//     $insert_id is set on its side. Local dedupe before the emitter proves
//     nothing about delivery to either destination.
//
// The emitter and the registry are injectable so all of the above is
// provable in a pure node unit test without a DOM.
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
 * Not atomic across tabs (localStorage has no check-and-set) and scoped to
 * this browser profile — see the header for the documented limits.
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

export type ResultadoCompraConcluida =
  /** emitted to sendEvent (both sinks) */
  | 'emitida'
  /** this browser already emitted this transaction_id — suppressed */
  | 'ja_emitida'
  /** no transaction_id available on this surface — suppressed, UI unaffected */
  | 'sem_identidade';

/**
 * The ONE entry point for the client purchase confirmation. Never throws.
 * Blank transactionId → 'sem_identidade' and NOTHING is emitted: an event
 * that cannot be tied to a payment must not be counted as one.
 */
export function registrarCompraConcluida(
  input: CompraConcluidaInput,
  deps: RegistrarCompraDeps = {},
): ResultadoCompraConcluida {
  const id = input.transactionId.trim();
  if (!id) return 'sem_identidade';
  const registro = deps.registro ?? registroDoNavegador();
  const emitir = deps.emitir ?? sendEvent;
  if (registro.jaEmitida(id)) return 'ja_emitida';
  registro.marcarEmitida(id);
  emitir(EVENTO_COMPRA_CONCLUIDA, { ...montarPropsCompraConcluida({ ...input, transactionId: id }) });
  return 'emitida';
}

// ── PIX: first iniciar vs QR regenerate (Wheatley T1.5 contract, 4yse9) ──
//
// checkout_iniciado means "the visitor started ONE payment intent". On PIX,
// an expired/rejected QR sends the visitor back to the identity step and a
// NEW charge (new txid) is minted for the SAME intent — that used to re-emit
// checkout_iniciado, inflating the funnel top. The regenerate path emits
// pix_qr_regenerado instead; checkout_iniciado stays exactly once per intent.

export const EVENTO_CHECKOUT_INICIADO = 'checkout_iniciado';
export const EVENTO_PIX_QR_REGENERADO = 'pix_qr_regenerado';

export interface InicioCheckoutPixInput {
  /** True when this iniciar follows onPixRetry (expired/rejected QR). */
  regenerando: boolean;
  /** txid of the charge just minted (the QR now on screen). */
  transactionId: string;
  valorCentavos: number;
  /** Present on the cart surface; absent on the single-gift modal. */
  quantidadeItens?: number;
}

export type EmissorEvento = (eventName: string, props: Record<string, unknown>) => void;

/**
 * Emits checkout_iniciado (props unchanged from before: valor_centavos,
 * quantidade_itens?, metodo) on the FIRST successful iniciar of an intent,
 * and pix_qr_regenerado {transaction_id, valor_centavos, metodo:'pix'} when
 * the same intent regenerates its QR. Returns the event name emitted.
 *
 * Contract guard: pix_qr_regenerado means "a NEW QR (txid) was issued". A
 * regenerate flag with no txid (e.g. the server answered stripe_embedded on
 * the retry) is NOT a QR regenerate — it falls back to the plain
 * checkout_iniciado shape rather than recording a QR event with a blank id.
 */
export function emitirInicioCheckoutPix(
  input: InicioCheckoutPixInput,
  emitir: EmissorEvento = sendEvent,
): string {
  const txid = input.transactionId.trim();
  if (input.regenerando && txid) {
    emitir(EVENTO_PIX_QR_REGENERADO, {
      transaction_id: txid,
      valor_centavos: input.valorCentavos,
      metodo: 'pix',
    });
    return EVENTO_PIX_QR_REGENERADO;
  }
  const props: Record<string, unknown> = { valor_centavos: input.valorCentavos };
  if (input.quantidadeItens !== undefined) props.quantidade_itens = input.quantidadeItens;
  props.metodo = 'pix';
  emitir(EVENTO_CHECKOUT_INICIADO, props);
  return EVENTO_CHECKOUT_INICIADO;
}
