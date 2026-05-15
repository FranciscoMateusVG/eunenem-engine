import type { FinancialPaymentReferenceId, FinancialPaymentStatus } from '../domain/financial.js';

export class FinancialPaymentNotApprovedError extends Error {
  public readonly code = 'FINANCIAL_PAYMENT_NOT_APPROVED' as const;

  constructor(
    public readonly paymentId: FinancialPaymentReferenceId,
    public readonly status: FinancialPaymentStatus,
  ) {
    super(`Payment "${paymentId}" is "${status}" and cannot generate financial entries.`);
    this.name = 'FinancialPaymentNotApprovedError';
  }
}
