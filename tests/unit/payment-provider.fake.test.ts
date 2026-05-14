import { describe, expect, it } from 'vitest';
import { PaymentProviderFake } from '../../src/adapters/payment-provider.fake.js';

const paymentId = '550e8400-e29b-41d4-a716-446655440301';
const paymentIntentId = '550e8400-e29b-41d4-a716-446655440302';
const externalTransactionId = '550e8400-e29b-41d4-a716-446655440303';
const fixedDate = new Date('2026-05-01T12:00:00.000Z');

describe('PaymentProviderFake', () => {
  it('returns an approved external transaction by default', async () => {
    const provider = new PaymentProviderFake({
      transactionIdFactory: () => externalTransactionId,
      clock: () => fixedDate,
    });

    const transaction = await provider.requestPayment({
      paymentId,
      paymentIntentId,
      amountCents: 8400,
      method: 'pix',
    });

    expect(transaction).toEqual({
      id: externalTransactionId,
      provider: 'fake-provider',
      status: 'approved',
      amountCents: 8400,
      createdAt: fixedDate,
      rawStatus: 'approved',
    });
  });

  it('can return a rejected external transaction', async () => {
    const provider = new PaymentProviderFake({
      resultStatus: 'rejected',
      transactionIdFactory: () => externalTransactionId,
      clock: () => fixedDate,
    });

    const transaction = await provider.requestPayment({
      paymentId,
      paymentIntentId,
      amountCents: 8400,
      method: 'credit_card',
    });

    expect(transaction.status).toBe('rejected');
    expect(transaction.rawStatus).toBe('rejected');
  });

  it('can simulate an amount mismatch from the provider', async () => {
    const provider = new PaymentProviderFake({
      transactionIdFactory: () => externalTransactionId,
      transactionAmountCents: 8500,
      clock: () => fixedDate,
    });

    const transaction = await provider.requestPayment({
      paymentId,
      paymentIntentId,
      amountCents: 8400,
      method: 'pix',
    });

    expect(transaction.amountCents).toBe(8500);
  });
});
