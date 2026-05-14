import type { MoneyCents } from '../domain/money.js';

export class PaymentAmountMismatchError extends Error {
  public readonly code = 'PAYMENT_AMOUNT_MISMATCH' as const;

  constructor(
    public readonly expectedAmountCents: MoneyCents,
    public readonly actualAmountCents: MoneyCents,
  ) {
    super(
      `Payment amount mismatch: expected ${expectedAmountCents} cents, got ${actualAmountCents} cents.`,
    );
    this.name = 'PaymentAmountMismatchError';
  }
}
