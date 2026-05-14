import { describe, expect, it } from 'vitest';
import { PaymentEventPublisherMemory } from '../../src/adapters/payment-event-publisher.memory.js';
import { createPaymentEvent, createPendingPayment } from '../../src/domain/payments.js';

const paymentId = '550e8400-e29b-41d4-a716-446655440401';
const paymentIntentId = '550e8400-e29b-41d4-a716-446655440402';
const contributionId = '550e8400-e29b-41d4-a716-446655440403';
const firstEventId = '550e8400-e29b-41d4-a716-446655440404';
const secondEventId = '550e8400-e29b-41d4-a716-446655440405';
const fixedDate = new Date('2026-05-01T12:00:00.000Z');

describe('PaymentEventPublisherMemory', () => {
  it('stores published events in order', async () => {
    const publisher = new PaymentEventPublisherMemory();
    const payment = createPendingPayment({
      paymentId,
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
      createdAt: fixedDate,
    });
    const firstEvent = createPaymentEvent({
      id: firstEventId,
      type: 'payment.intent_created',
      payment,
      occurredAt: fixedDate,
    });
    const secondEvent = createPaymentEvent({
      id: secondEventId,
      type: 'payment.intent_created',
      payment,
      occurredAt: fixedDate,
    });

    await publisher.publish(firstEvent);
    await publisher.publish(secondEvent);

    expect(publisher.getPublishedEvents()).toEqual([firstEvent, secondEvent]);
  });
});
