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
 * Provedor de pagamento (porta) — SYNCHRONOUS approve/reject handshake.
 *
 * Models the topology where the backend mints the transaction in-band
 * (Pagarme direct, Pix-direct). For ASYNCHRONOUS pre-session + webhook
 * topologies (Stripe embedded checkout), see the sibling port
 * `CheckoutSessionProvider` in checkout-session-provider.ts. An adapter
 * MAY implement both ports (Stripe Connect, future hybrid providers).
 */
export interface PagamentoProvider {
  solicitarPagamento(input: SolicitarPagamentoInput): Promise<TransacaoExterna>;
}
