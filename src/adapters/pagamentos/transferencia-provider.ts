import type { MoneyCents } from '../../domain/money.js';

/**
 * aperture-vvh2j — `TransferenciaProvider` port (spec §3.1).
 *
 * The outbound PIX payout rail behind the repasse FSM. Mirrors the
 * `PagamentoProvider` idiom: business outcomes are RETURN-TYPED
 * discriminated unions (never thrown); only infrastructure faults throw.
 *
 * The real adapter (`provider.inter.ts`, aperture-ju5w2) speaks Banco
 * Inter's Banking API; `provider.fake.ts` is the deterministic
 * test/staging adapter.
 *
 * CONTRACT NOTES that carry the double-pay invariant (spec §6):
 *  - `referencia` is the caller-supplied STABLE reference, derived once
 *    from the repasse id and reused across every attempt. The provider
 *    MUST forward it to Inter unchanged so a retried attempt is the same
 *    payment identity, and `buscarPagamentos` can match on it.
 *  - `pagarPix` returning `agendado_aprovacao` is NOT success — it means
 *    the payment is parked in Inter's own approval workflow; the caller
 *    diverts the repasse to `verificando` and reconciles. Treating it as
 *    paid is the exact 1.0 defect this design forbids.
 *  - A THROWN error from `pagarPix` is ambiguous by contract (a payment
 *    MAY exist) UNLESS it is a `TransferenciaTransitoriaError` (below),
 *    which asserts no payment was created and is therefore safe to retry.
 */

/** Outcome of a `pagarPix` call. */
export type PagarPixOutcome =
  | { readonly outcome: 'pago'; readonly codigoSolicitacao: string }
  // Inter-side approval workflow — a payment may settle later; NOT success.
  | { readonly outcome: 'agendado_aprovacao'; readonly codigoSolicitacao: string }
  // Clean rejection: the payment was definitively NOT created.
  | { readonly outcome: 'rejeitado'; readonly codigoSolicitacao?: string; readonly erro: string };

export interface PagarPixInput {
  /** chave PIX — cpf/cnpj/email/telefone/aleatoria. NEVER logged. */
  readonly chave: string;
  readonly valorCents: MoneyCents;
  /** e.g. "EuNeném — repasse <shortid>". */
  readonly descricao: string;
  /** Stable per-repasse reference. NEVER regenerated on retry. */
  readonly referencia: string;
}

/** Terminal/interim status of a previously-created Inter payment. */
export type ConsultarPagamentoStatus =
  | 'pago'
  | 'em_processamento'
  | 'aguardando_aprovacao'
  | 'cancelado'
  | 'rejeitado';

export interface ConsultarPagamentoResult {
  readonly status: ConsultarPagamentoStatus;
  readonly raw: unknown;
}

export interface BuscarPagamentosInput {
  /** ISO date (yyyy-mm-dd) window start. */
  readonly dataInicio: string;
  /** ISO date (yyyy-mm-dd) window end. */
  readonly dataFim: string;
}

export interface PagamentoEncontrado {
  readonly codigoSolicitacao: string;
  readonly valorCents: MoneyCents;
  /**
   * The stable per-repasse `referencia` we sent to Inter, echoed back on the
   * payment record. This is the STRONG reconciliation key — the caller
   * matches on it, NOT on valor alone. Matching on valor-only can adopt an
   * unrelated same-amount payment (falsely `pago`) or miss the real one
   * (falsely `falhou` → admin retry → second PIX). The real adapter
   * (aperture-ju5w2) MUST populate this from Inter's payment record; a
   * record whose referencia can't be recovered is NOT a safe match.
   */
  readonly referencia: string;
  readonly chave?: string;
  readonly status: string;
  /**
   * The movement date (yyyy-mm-dd) from Inter's extrato, when present — gives
   * the admin a real timestamp on a reconciliation candidate (aperture-477nz).
   */
  readonly dataMovimento?: string;
}

export interface TransferenciaProvider {
  /**
   * Fire a PIX to a chave. Returns a discriminated outcome; throws only on
   * infrastructure failure. A thrown `TransferenciaTransitoriaError` means
   * the request never reached Inter (safe to retry); any other throw is
   * ambiguous (a payment MAY exist → the caller diverts to `verificando`).
   */
  pagarPix(input: PagarPixInput): Promise<PagarPixOutcome>;

  /** Poll a known payment's status by Inter's codigoSolicitacao. */
  consultarPagamento(codigoSolicitacao: string): Promise<ConsultarPagamentoResult>;

  /**
   * Reconciliation fallback when we crashed before capturing
   * codigoSolicitacao: search Inter's payment history in a date window.
   * The caller matches by valor + chave + referencia.
   */
  buscarPagamentos(input: BuscarPagamentosInput): Promise<readonly PagamentoEncontrado[]>;
}

/**
 * Thrown by an adapter ONLY when it is certain the request never created a
 * payment at Inter (e.g. a connection refused before the request was
 * sent, or a pre-flight validation failure). This is the sole "safe to
 * auto-retry" fault class — the executar handler rethrows it so pg-boss
 * retries. EVERY OTHER throw is treated as ambiguous and diverts the
 * repasse to `verificando`. Adapters must NOT use this for timeouts or
 * any post-send failure, where a payment may in fact have been created.
 */
export class TransferenciaTransitoriaError extends Error {
  readonly _tag = 'TransferenciaTransitoriaError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransferenciaTransitoriaError';
  }
}
