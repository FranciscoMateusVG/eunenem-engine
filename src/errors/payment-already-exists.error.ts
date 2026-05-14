import type { PaymentId, PaymentIntentId } from '../domain/payments.js';

export class PaymentAlreadyExistsError extends Error {
  public readonly code = 'PAYMENT_ALREADY_EXISTS' as const;

  constructor(
    public readonly paymentId: PaymentId,
    public readonly paymentIntentId?: PaymentIntentId,
  ) {
    const suffix = paymentIntentId ? ` or intent "${paymentIntentId}"` : '';
    super(`Payment "${paymentId}"${suffix} already exists.`);
    this.name = 'PaymentAlreadyExistsError';
  }
}
