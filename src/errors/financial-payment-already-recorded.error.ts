import type { FinancialPaymentReferenceId } from '../domain/financial.js';

export class FinancialPaymentAlreadyRecordedError extends Error {
  public readonly code = 'FINANCIAL_PAYMENT_ALREADY_RECORDED' as const;

  constructor(public readonly paymentId: FinancialPaymentReferenceId) {
    super(`Payment "${paymentId}" already has financial entries recorded.`);
    this.name = 'FinancialPaymentAlreadyRecordedError';
  }
}
