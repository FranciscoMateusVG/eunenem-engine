/**
 * Raised when a Checkout orchestrator that requires a Recebedor (e.g.
 * `iniciarRepasseRecebedor`) is invoked against a Campanha that doesn't
 * yet have one. Creation/contribution flows remain valid without a
 * Recebedor — only saldo withdrawal is gated on its presence.
 */
export class CheckoutCampanhaSemRecebedorError extends Error {
  public readonly code = 'CHECKOUT_CAMPANHA_SEM_RECEBEDOR' as const;

  constructor(public readonly idCampanha: string) {
    super(
      `Campanha "${idCampanha}" nao possui Recebedor cadastrado; operacao de repasse bloqueada.`,
    );
    this.name = 'CheckoutCampanhaSemRecebedorError';
  }
}
