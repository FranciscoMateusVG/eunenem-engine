import type { PaymentId } from '../domain/payments.js';

export class PaymentNotFoundError extends Error {
  public readonly code = 'PAYMENT_NOT_FOUND' as const;

  constructor(public readonly paymentId: PaymentId) {
    super(`Payment "${paymentId}" not found.`);
    this.name = 'PaymentNotFoundError';
  }
}
