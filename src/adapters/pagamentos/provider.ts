import type { MoneyCents } from '../../domain/money.js';
import type { TransacaoExterna } from '../../domain/pagamentos/entities/pagamento.js';
import type {
  IdIntencaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';
import type { MetodoPagamento } from '../../domain/pagamentos/value-objects/metodo-pagamento.js';

export interface SolicitarPagamentoInput {
  readonly idPagamento: IdPagamento;
  readonly idIntencaoPagamento: IdIntencaoPagamento;
  readonly amountCents: MoneyCents;
  readonly metodo: MetodoPagamento;
  /**
   * Optional provider-side session reference (aperture-xaha2). When the
   * Pagamento was created via the CheckoutSessionProvider flow, this is
   * the session id (e.g. Stripe `cs_test_...`). The Stripe adapter uses
   * it to look up the actual transaction id (`payment_intent`) from the
   * provider-side session rather than minting a new transaction. The fake
   * adapter (and any sync-topology adapter) ignores this field.
   */
  readonly externalRef?: string | null;
}

/**
 * Refund input for the provider's refund call (plan 0015 / aperture-ucgok).
 *
 * Stripe's Refunds API keys off the charge id (`ch_xxx`) — which lives
 * on `IntencaoPagamento.chargeExternalRef` post-aprovação. For PagarMe /
 * sync-topology providers, `idPagamento` is the lookup key. The adapter
 * picks whichever it needs and ignores the rest.
 *
 * Optional `reason` flows through to Stripe's `reason` field (one of
 * `duplicate | fraudulent | requested_by_customer`); we default to
 * `requested_by_customer` at the adapter when unset.
 */
export interface RefundarPagamentoInput {
  readonly idPagamento: IdPagamento;
  readonly chargeExternalRef: string | null;
  readonly paymentIntentExternalRef: string | null;
  readonly amountCents: MoneyCents;
  readonly reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}

/**
 * Result returned by the provider after firing the refund.
 *
 * `id` is the provider-side refund identifier (Stripe's `re_xxx` /
 * PagarMe's refund id). `status` collapses provider-specific lifecycles
 * to a binary — anything Stripe reports as `succeeded` or `pending`
 * counts as `aceito` (the money path is committed; eventual settlement
 * happens out-of-band on the provider side); explicit failures
 * surface as `recusado` and the use-case rolls back.
 */
export interface RefundarPagamentoResult {
  readonly id: string;
  readonly status: 'aceito' | 'recusado';
  readonly amountCents: MoneyCents;
  readonly statusBruto?: string;
}

/**
 * Provedor de pagamento (porta) — SYNCHRONOUS approve/reject handshake.
 *
 * Models the topology where the backend mints the transaction in-band
 * (Pagarme direct, Pix-direct). For ASYNCHRONOUS pre-session + webhook
 * topologies (Stripe embedded checkout), see the sibling port
 * `CheckoutSessionProvider` in checkout-session-provider.ts. An adapter
 * MAY implement both ports (Stripe Connect, future hybrid providers).
 *
 * **Plan 0015 (aperture-ucgok).** The port gains `refundarPagamento` —
 * the upstream-facing call for the new `estornar-pagamento` use-case.
 * Stripe adapter calls `stripe.refunds.create({ charge: ch_xxx, ... })`;
 * the fake adapter mints a synthetic refund id and returns `aceito`
 * (configurable for failure-path tests).
 */
export interface PagamentoProvider {
  solicitarPagamento(input: SolicitarPagamentoInput): Promise<TransacaoExterna>;
  refundarPagamento(input: RefundarPagamentoInput): Promise<RefundarPagamentoResult>;
}
