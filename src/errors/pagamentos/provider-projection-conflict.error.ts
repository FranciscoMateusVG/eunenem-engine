export class PagamentoProviderProjectionConflictError extends Error {
  readonly code = 'PAGAMENTO_PROVIDER_PROJECTION_CONFLICT';

  constructor(readonly field: 'paymentIntentExternalRef' | 'chargeExternalRef') {
    super(`Conflito de identidade do provedor em ${field}`);
    this.name = 'PagamentoProviderProjectionConflictError';
  }
}
