import type { PaymentId, PaymentStatus } from '../domain/payments.js';

export class PaymentInvalidStatusTransitionError extends Error {
  public readonly code = 'PAYMENT_INVALID_STATUS_TRANSITION' as const;

  constructor(
    public readonly paymentId: PaymentId,
    public readonly currentStatus: PaymentStatus,
    public readonly targetStatus: PaymentStatus,
  ) {
    super(`Payment "${paymentId}" cannot transition from "${currentStatus}" to "${targetStatus}".`);
    this.name = 'PaymentInvalidStatusTransitionError';
  }
}
