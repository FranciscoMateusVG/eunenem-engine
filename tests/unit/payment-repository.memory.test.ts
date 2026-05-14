import { describe, expect, it } from 'vitest';
import { PaymentRepositoryMemory } from '../../src/adapters/payment-repository.memory.js';
import { createPendingPayment } from '../../src/domain/payments.js';
import { PaymentAlreadyExistsError } from '../../src/errors/payment-already-exists.error.js';
import { PaymentNotFoundError } from '../../src/errors/payment-not-found.error.js';

const paymentId = '550e8400-e29b-41d4-a716-446655440201';
const paymentIntentId = '550e8400-e29b-41d4-a716-446655440202';
const contributionId = '550e8400-e29b-41d4-a716-446655440203';
const createdAt = new Date('2026-05-01T12:00:00.000Z');

function makePayment(id = paymentId) {
  return createPendingPayment({
    paymentId: id,
    paymentIntentId,
    valueComposition: {
      contributionId,
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      feePayer: 'contributor',
    },
    amountToChargeCents: 8400,
    method: 'pix',
    createdAt,
  });
}

describe('PaymentRepositoryMemory', () => {
  it('saves and finds a payment by id', async () => {
    const repository = new PaymentRepositoryMemory();
    const payment = makePayment();

    await repository.save(payment);

    await expect(repository.findById(payment.id)).resolves.toEqual(payment);
  });

  it('rejects duplicate payment ids on save', async () => {
    const repository = new PaymentRepositoryMemory();
    const payment = makePayment();

    await repository.save(payment);

    await expect(repository.save(payment)).rejects.toThrow(PaymentAlreadyExistsError);
  });

  it('updates an existing payment', async () => {
    const repository = new PaymentRepositoryMemory();
    const payment = makePayment();
    const updated = { ...payment, updatedAt: new Date('2026-05-01T12:10:00.000Z') };

    await repository.save(payment);
    await repository.update(updated);

    await expect(repository.findById(payment.id)).resolves.toEqual(updated);
  });

  it('throws when updating a missing payment', async () => {
    const repository = new PaymentRepositoryMemory();

    await expect(repository.update(makePayment())).rejects.toThrow(PaymentNotFoundError);
  });
});
