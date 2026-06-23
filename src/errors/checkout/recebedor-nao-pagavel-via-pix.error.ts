/**
 * Raised when a Checkout repasse/payout is requested for a Campanha whose
 * active Recebedor uses the `'conta'` (bank-account) receiving method. The
 * PIX repasse rail is the only payout path that exists; a `'conta'` receiver
 * has no PIX key and there is no bank-transfer rail yet, so the orchestrator
 * (`iniciarRepasseRecebedor`) short-circuits BEFORE any Financeiro
 * delegation — the cents-sweep never runs. Manual payout is the operator's
 * job until a bank-transfer rail lands.
 */
export class CheckoutRecebedorNaoPagavelViaPixError extends Error {
  public readonly code = 'CHECKOUT_RECEBEDOR_NAO_PAGAVEL_VIA_PIX' as const;

  constructor(public readonly idCampanha: string) {
    super(
      `Recebedor ativo da campanha "${idCampanha}" usa metodo "conta"; repasse via PIX nao e possivel.`,
    );
    this.name = 'CheckoutRecebedorNaoPagavelViaPixError';
  }
}
