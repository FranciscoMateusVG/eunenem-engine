import { describe, expect, it } from 'vitest';
import {
  approvePendingPayment,
  createPaymentEvent,
  createPendingPayment,
  type ExternalPaymentTransaction,
  PaymentMethodSchema,
  PaymentValueCompositionSnapshotSchema,
  rejectPendingPayment,
} from '../../src/domain/payments.js';

const paymentId = '550e8400-e29b-41d4-a716-446655440101';
const paymentIntentId = '550e8400-e29b-41d4-a716-446655440102';
const contributionId = '550e8400-e29b-41d4-a716-446655440103';
const externalTransactionId = '550e8400-e29b-41d4-a716-446655440104';
const eventId = '550e8400-e29b-41d4-a716-446655440105';
const createdAt = new Date('2026-05-01T12:00:00.000Z');
const updatedAt = new Date('2026-05-01T12:05:00.000Z');

const valueComposition = {
  contributionId,
  contributionAmountCents: 8000,
  feeAmountCents: 400,
  totalPaidCents: 8400,
  receiverAmountCents: 8000,
  feePayer: 'contributor' as const,
};

const approvedTransaction: ExternalPaymentTransaction = {
  id: externalTransactionId,
  provider: 'fake-provider',
  status: 'approved',
  amountCents: 8400,
  createdAt: updatedAt,
  rawStatus: 'approved',
};

describe('PaymentValueCompositionSnapshotSchema', () => {
  it('accepts the canonical Taxas composition snapshot', () => {
    expect(PaymentValueCompositionSnapshotSchema.safeParse(valueComposition).success).toBe(true);
  });
});

describe('PaymentMethodSchema', () => {
  it('accepts the initial supported methods', () => {
    expect(PaymentMethodSchema.safeParse('pix').success).toBe(true);
    expect(PaymentMethodSchema.safeParse('credit_card').success).toBe(true);
  });

  it('rejects unsupported payment methods', () => {
    expect(PaymentMethodSchema.safeParse('boleto').success).toBe(false);
  });
});

describe('createPendingPayment', () => {
  it('creates a pending payment for the total paid amount', () => {
    const payment = createPendingPayment({
      paymentId,
      paymentIntentId,
      valueComposition,
      amountToChargeCents: 8400,
      method: 'pix',
      createdAt,
    });

    expect(payment.id).toBe(paymentId);
    expect(payment.intent.contributionId).toBe(contributionId);
    expect(payment.intent.amountCents).toBe(8400);
    expect(payment.status).toBe('pending');
    expect(payment.externalTransaction).toBeUndefined();
  });

  it('rejects a charge amount different from totalPaidCents', () => {
    expect(() =>
      createPendingPayment({
        paymentId,
        paymentIntentId,
        valueComposition,
        amountToChargeCents: 8300,
        method: 'pix',
        createdAt,
      }),
    ).toThrow('Payment amount must match value composition total paid amount.');
  });
});

describe('payment status transitions', () => {
  it('approves a pending payment with an approved external transaction', () => {
    const payment = createPendingPayment({
      paymentId,
      paymentIntentId,
      valueComposition,
      amountToChargeCents: 8400,
      method: 'pix',
      createdAt,
    });

    const approved = approvePendingPayment(payment, approvedTransaction, updatedAt);

    expect(approved.status).toBe('approved');
    expect(approved.externalTransaction?.id).toBe(externalTransactionId);
    expect(approved.updatedAt).toEqual(updatedAt);
  });

  it('rejects a pending payment with a rejected external transaction', () => {
    const payment = createPendingPayment({
      paymentId,
      paymentIntentId,
      valueComposition,
      amountToChargeCents: 8400,
      method: 'credit_card',
      createdAt,
    });

    const rejected = rejectPendingPayment(
      payment,
      { ...approvedTransaction, status: 'rejected', rawStatus: 'rejected' },
      updatedAt,
    );

    expect(rejected.status).toBe('rejected');
    expect(rejected.externalTransaction?.status).toBe('rejected');
  });

  it('does not approve a rejected payment', () => {
    const payment = createPendingPayment({
      paymentId,
      paymentIntentId,
      valueComposition,
      amountToChargeCents: 8400,
      method: 'pix',
      createdAt,
    });
    const rejected = rejectPendingPayment(
      payment,
      { ...approvedTransaction, status: 'rejected', rawStatus: 'rejected' },
      updatedAt,
    );

    expect(() => approvePendingPayment(rejected, approvedTransaction, updatedAt)).toThrow(
      `Payment "${paymentId}" cannot be approved from status "rejected".`,
    );
  });

  it('does not reject an approved payment', () => {
    const payment = createPendingPayment({
      paymentId,
      paymentIntentId,
      valueComposition,
      amountToChargeCents: 8400,
      method: 'pix',
      createdAt,
    });
    const approved = approvePendingPayment(payment, approvedTransaction, updatedAt);

    expect(() =>
      rejectPendingPayment(
        approved,
        { ...approvedTransaction, status: 'rejected', rawStatus: 'rejected' },
        updatedAt,
      ),
    ).toThrow(`Payment "${paymentId}" cannot be rejected from status "approved".`);
  });
});

describe('createPaymentEvent', () => {
  it('creates an event from payment state', () => {
    const payment = approvePendingPayment(
      createPendingPayment({
        paymentId,
        paymentIntentId,
        valueComposition,
        amountToChargeCents: 8400,
        method: 'pix',
        createdAt,
      }),
      approvedTransaction,
      updatedAt,
    );

    const event = createPaymentEvent({
      id: eventId,
      type: 'payment.approved',
      payment,
      occurredAt: updatedAt,
    });

    expect(event).toMatchObject({
      id: eventId,
      type: 'payment.approved',
      paymentId,
      paymentIntentId,
      contributionId,
      amountCents: 8400,
      status: 'approved',
      externalTransactionId,
    });
  });
});
