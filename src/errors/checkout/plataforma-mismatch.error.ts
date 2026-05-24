/**
 * Raised when a Checkout orchestrator detects that a referenced aggregate
 * (Campanha, Contribuicao via Campanha, etc.) belongs to a different
 * plataforma than the one named in the orchestrator's input.
 *
 * This is the cross-tenant attack-surface guard: the typed error makes the
 * intent visible at the call site (vs. a generic 404), and the orchestrator's
 * span records it with structured attributes for auditability.
 */
export class CheckoutPlataformaMismatchError extends Error {
  public readonly code = 'CHECKOUT_PLATAFORMA_MISMATCH' as const;

  constructor(
    public readonly idPlataformaSolicitada: string,
    public readonly idPlataformaDoRecurso: string,
  ) {
    super(
      `Plataforma do recurso (${idPlataformaDoRecurso}) nao corresponde a plataforma solicitada (${idPlataformaSolicitada}).`,
    );
    this.name = 'CheckoutPlataformaMismatchError';
  }
}
