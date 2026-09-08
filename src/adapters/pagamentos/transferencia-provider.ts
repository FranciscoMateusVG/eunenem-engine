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
 *  - Any documented accepted 2xx shape with a non-empty Inter receipt returns
 *    `aceito_pelo_banco`. That ends the platform journey without claiming the
 *    operator approved the transfer in Inter or that the PIX settled.
 *  - A THROWN error from `pagarPix` is ambiguous by contract (a payment
 *    MAY exist) UNLESS it is a `TransferenciaTransitoriaError` (below),
 *    which asserts no payment was created and is therefore safe to retry.
 */

/** Outcome of a `pagarPix` call. */
export type PagarPixOutcome =
  | {
      /** Inter accepted the request; downstream bank approval/settlement is out of platform scope. */
      readonly outcome: 'aceito_pelo_banco';
      readonly codigoSolicitacao: string;
      readonly diagnostics?: TransferenciaProviderDiagnostics;
    }
  // Clean rejection: the payment was definitively NOT created.
  | {
      readonly outcome: 'rejeitado';
      readonly codigoSolicitacao?: string;
      readonly erro: string;
      readonly diagnostics?: TransferenciaProviderDiagnostics;
    };

/**
 * Sanitized, finite evidence observed at the provider boundary.
 *
 * Every operator-facing string-valued member is an application-owned enum
 * except `providerRequestId`, which is accepted only from Inter's documented
 * correlation field under a strict bounded grammar.
 *
 * `privateProviderError` is the sole exception: a bounded non-2xx response body
 * retained for the existing campaign-scoped admin diagnosis path. It is
 * storage-only private data. Never log, trace, serialize publicly, or include
 * it in thrown error messages.
 */
export interface TransferenciaProviderDiagnostics {
  readonly operation: 'pagar_pix';
  readonly responseClass:
    | 'accepted'
    | 'validation_rejection'
    | 'ambiguous_http'
    | 'pre_send_failure'
    | 'ambiguous_transport'
    | 'invalid_response'
    | 'local_rejection'
    | 'diagnostic_unavailable';
  readonly httpStatus: number | null;
  readonly providerRequestId: string | null;
  readonly diagnosticCode:
    | 'invalid_pix_key'
    | 'invalid_amount'
    | 'invalid_description'
    | 'invalid_recipient'
    | 'invalid_request'
    | 'provider_rejection'
    | 'recipient_not_pix'
    | 'missing_reference'
    | 'diagnostic_unavailable';
  readonly diagnosticField: 'pix_key' | 'amount' | 'description' | 'recipient' | null;
  readonly diagnosticReason:
    | 'required'
    | 'invalid_format'
    | 'out_of_range'
    | 'not_owned'
    | 'unsupported'
    | 'diagnostic_unavailable';
  readonly privateProviderError?: TransferenciaProviderPrivateError | null;
}

/** Private non-2xx response evidence, bounded before it leaves the adapter. */
export interface TransferenciaProviderPrivateError {
  readonly body: string;
  readonly truncated: boolean;
}

export interface PagarPixInput {
  /** chave PIX — cpf/cnpj/email/telefone/aleatoria. NEVER logged. */
  readonly chave: string;
  readonly valorCents: MoneyCents;
  /** e.g. "EuNeném — repasse <shortid>". */
  readonly descricao: string;
  /** Stable per-repasse reference. NEVER regenerated on retry. */
  readonly referencia: string;
}

/** Legacy query result retained for the disabled confirmation adapter surface. */
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
  readonly diagnostics: TransferenciaProviderDiagnostics | undefined;
  constructor(
    message: string,
    options?: { cause?: unknown; diagnostics?: TransferenciaProviderDiagnostics },
  ) {
    super(message, options);
    this.name = 'TransferenciaTransitoriaError';
    this.diagnostics = options?.diagnostics;
  }
}

/**
 * A payment request may have reached Inter, but its result is not proven.
 * The executar use case intentionally treats this exactly like every other
 * non-transient throw: move to `verificando`, never automatically retry.
 */
export class TransferenciaAmbiguaError extends Error {
  readonly _tag = 'TransferenciaAmbiguaError';
  readonly diagnostics: TransferenciaProviderDiagnostics;

  constructor(
    message: string,
    diagnostics: TransferenciaProviderDiagnostics,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransferenciaAmbiguaError';
    this.diagnostics = diagnostics;
  }
}
