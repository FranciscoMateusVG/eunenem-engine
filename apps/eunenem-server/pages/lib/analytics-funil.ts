// aperture-qq74p — Tier 2 cart/checkout funnel events (bounded).
//
// Every event here fires from a REAL state transition, never from an
// inference: a cart line that actually changed (the reducer returned a new
// state), a drawer that actually went closed→open, an `iniciar` mutation
// that actually rejected, a PIX charge the SERVER reported expired/rejected.
// Props are finite — no item names, no free text, no URL/query, no PII
// (Cipher's free-text residual on gift_name is a pending operator decision;
// nothing new is added to it). Analytics is best-effort on both sinks: none
// of this is delivery or ingestion evidence.
import { sendEvent } from './analytics.js';
import type { MetodoPagamento } from './paginaApi.js';

export type EmissorEvento = (eventName: string, props: Record<string, unknown>) => void;

// ── Cart line deltas (from the real reducer transition) ───────────────────

export const EVENTO_CARRINHO_ITEM_ADICIONADO = 'carrinho_item_adicionado';
export const EVENTO_CARRINHO_ITEM_REMOVIDO = 'carrinho_item_removido';
export const EVENTO_CARRINHO_ABERTO = 'carrinho_aberto';

export type OrigemCarrinho = 'card' | 'drawer';

/** The minimal line shape the delta needs (structural — the cart's CartLine satisfies it). */
export interface LinhaCarrinhoMinima {
  nome: string;
  quantidade: number;
  valorCents: number;
}

export interface DeltaLinhaCarrinho {
  tipo: 'adicionado' | 'removido';
  /** Line quantity AFTER the transition (0 = line gone). */
  quantidade: number;
  /** Unit price in centavos. */
  valorCentavos: number;
}

/**
 * Compares one line before/after a reducer transition. Returns null when
 * nothing changed for that line (cap reached, esgotado, unknown nome) — the
 * caller emits nothing in that case. `clear` is deliberately NOT a removal:
 * it runs after a purchase, and callers never route it here.
 */
export function deltaLinhaCarrinho(
  antes: readonly LinhaCarrinhoMinima[],
  depois: readonly LinhaCarrinhoMinima[],
  nome: string,
): DeltaLinhaCarrinho | null {
  const a = antes.find((l) => l.nome === nome);
  const d = depois.find((l) => l.nome === nome);
  const qa = a?.quantidade ?? 0;
  const qd = d?.quantidade ?? 0;
  if (qa === qd) return null;
  const valorCentavos = (d ?? a)?.valorCents ?? 0;
  return qd > qa
    ? { tipo: 'adicionado', quantidade: qd, valorCentavos }
    : { tipo: 'removido', quantidade: qd, valorCentavos };
}

/** Emits the cart event for a non-null delta. Returns the event name or null. */
export function emitirDeltaCarrinho(
  delta: DeltaLinhaCarrinho | null,
  origem: OrigemCarrinho,
  emitir: EmissorEvento = sendEvent,
): string | null {
  if (!delta) return null;
  const nome =
    delta.tipo === 'adicionado' ? EVENTO_CARRINHO_ITEM_ADICIONADO : EVENTO_CARRINHO_ITEM_REMOVIDO;
  emitir(nome, { valor_centavos: delta.valorCentavos, quantidade: delta.quantidade, origem });
  return nome;
}

/**
 * Synchronous "current state" cell the wrapper below reads and ADVANCES
 * before dispatching. React's committed state lags dispatch: two clicks in
 * the same tick would otherwise both predict from the same stale state and
 * emit a duplicate/incorrect `quantidade` (Izzy, qq74p pre-freeze). The
 * provider backs this with a ref it re-syncs from committed state on every
 * render; the reducer stays pure, so the predicted sequence equals the
 * committed one.
 */
export interface CelulaEstado<S> {
  obter(): S;
  avancar(proximo: S): void;
}

/**
 * The wrapper boundary the cart provider uses for add/increment/decrement/
 * remove: predict the transition from the CURRENT (cell) state, emit only a
 * real delta, advance the cell, then dispatch. Exported so the boundary is
 * testable in node with a fake cell + a sequential replay of dispatches.
 */
export function despacharComDelta<S extends { lines: readonly LinhaCarrinhoMinima[] }, A>(
  celula: CelulaEstado<S>,
  reducer: (estado: S, acao: A) => S,
  dispatch: (acao: A) => void,
  acao: A,
  nome: string,
  origem: OrigemCarrinho,
  emitir: EmissorEvento = sendEvent,
): string | null {
  const antes = celula.obter();
  const depois = reducer(antes, acao);
  const evento = emitirDeltaCarrinho(deltaLinhaCarrinho(antes.lines, depois.lines, nome), origem, emitir);
  celula.avancar(depois);
  dispatch(acao);
  return evento;
}

export type OrigemAberturaCarrinho = 'adicionar' | 'botao';

/**
 * carrinho_aberto only on a real closed→open transition. Callers pass the
 * drawer's current isOpen; an already-open drawer emits nothing.
 */
export function emitirCarrinhoAberto(
  jaAberto: boolean,
  origem: OrigemAberturaCarrinho,
  emitir: EmissorEvento = sendEvent,
): boolean {
  if (jaAberto) return false;
  emitir(EVENTO_CARRINHO_ABERTO, { origem });
  return true;
}

// ── Checkout initiation failure (mutation REJECTED) ───────────────────────

export const EVENTO_CHECKOUT_FALHOU = 'checkout_falhou';

const CODIGO_TRPC = /^[A-Z][A-Z_]{2,40}$/;

/**
 * Finite error code from a tRPC client error (`error.data.code`, e.g.
 * BAD_REQUEST / CONFLICT / INTERNAL_SERVER_ERROR). Anything else — network
 * failure, non-tRPC throw, malformed shape — collapses to 'desconhecido'.
 * The message text is never read: it can carry user/order details.
 */
export function codigoErroTrpc(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'desconhecido';
  const data = (err as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return 'desconhecido';
  const code = (data as { code?: unknown }).code;
  return typeof code === 'string' && CODIGO_TRPC.test(code) ? code : 'desconhecido';
}

export interface CheckoutFalhouInput {
  metodo: MetodoPagamento;
  valorCentavos: number;
  quantidadeItens?: number;
  erro: unknown;
}

export function emitirCheckoutFalhou(
  input: CheckoutFalhouInput,
  emitir: EmissorEvento = sendEvent,
): void {
  const props: Record<string, unknown> = {
    etapa: 'iniciar',
    metodo: input.metodo,
    valor_centavos: input.valorCentavos,
    codigo: codigoErroTrpc(input.erro),
  };
  if (input.quantidadeItens !== undefined) props.quantidade_itens = input.quantidadeItens;
  emitir(EVENTO_CHECKOUT_FALHOU, props);
}

// ── PIX charge failure (SERVER-reported terminal status) ──────────────────

export const EVENTO_PAGAMENTO_FALHOU = 'pagamento_falhou';

export type MotivoPixFalhou = 'expirado' | 'rejeitado';

/**
 * Maps the polled server status to a failure motive. Anything that is not
 * a server-reported terminal failure (pendente, confirmado, a local countdown
 * that ran out before the server said so) → null → nothing emitted.
 */
export function motivoPixFalhou(statusServidor: string | undefined): MotivoPixFalhou | null {
  if (statusServidor === 'expirado') return 'expirado';
  if (statusServidor === 'rejeitado') return 'rejeitado';
  return null;
}

export interface PixFalhouInput {
  transactionId: string;
  valorCentavos: number;
  motivo: MotivoPixFalhou;
}

export function emitirPixFalhou(input: PixFalhouInput, emitir: EmissorEvento = sendEvent): void {
  emitir(EVENTO_PAGAMENTO_FALHOU, {
    metodo: 'pix',
    motivo: input.motivo,
    transaction_id: input.transactionId,
    valor_centavos: input.valorCentavos,
  });
}
