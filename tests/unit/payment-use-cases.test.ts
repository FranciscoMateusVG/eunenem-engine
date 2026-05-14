import { describe, expect, it } from 'vitest';
import { PaymentEventPublisherMemory } from '../../src/adapters/payment-event-publisher.memory.js';
import { PaymentProviderFake } from '../../src/adapters/payment-provider.fake.js';
import { PaymentRepositoryMemory } from '../../src/adapters/payment-repository.memory.js';
import type { CreatePaymentIntentInput } from '../../src/domain/payments.js';
import { PaymentAmountMismatchError } from '../../src/errors/payment-amount-mismatch.error.js';
import { PaymentInvalidStatusTransitionError } from '../../src/errors/payment-invalid-status-transition.error.js';
import { PaymentNotFoundError } from '../../src/errors/payment-not-found.error.js';
import { PaymentsInvalidInputError } from '../../src/errors/payments-invalid-input.error.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { approvePayment } from '../../src/use-cases/approve-payment.js';
import { createPaymentIntent } from '../../src/use-cases/create-payment-intent.js';
import { getPaymentById } from '../../src/use-cases/get-payment-by-id.js';
import { rejectPayment } from '../../src/use-cases/reject-payment.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const paymentId = '550e8400-e29b-41d4-a716-446655440501';
const paymentIntentId = '550e8400-e29b-41d4-a716-446655440502';
const contributionId = '550e8400-e29b-41d4-a716-446655440503';
const externalTransactionId = '550e8400-e29b-41d4-a716-446655440504';

function makeCreatePaymentIntentInput(
  overrides: Partial<CreatePaymentIntentInput> = {},
): CreatePaymentIntentInput {
  return {
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
    ...overrides,
  };
}

describe('payment use cases', () => {
  it('creates and approves the canonical R$ 80 + R$ 4 payment flow', async () => {
    const paymentRepository = new PaymentRepositoryMemory();
    const paymentEventPublisher = new PaymentEventPublisherMemory();
    const paymentProvider = new PaymentProviderFake({
      transactionIdFactory: () => externalTransactionId,
      clock,
    });

    const created = await createPaymentIntent(
      { paymentRepository, paymentEventPublisher, clock, observability: silentObservability },
      makeCreatePaymentIntentInput(),
    );

    expect(created.status).toBe('pending');
    expect(created.intent.amountCents).toBe(8400);

    const approved = await approvePayment(
      {
        paymentRepository,
        paymentProvider,
        paymentEventPublisher,
        clock,
        observability: silentObservability,
      },
      { paymentId },
    );
    const loaded = await getPaymentById(
      { paymentRepository, observability: silentObservability },
      { paymentId },
    );

    expect(approved.status).toBe('approved');
    expect(approved.externalTransaction?.id).toBe(externalTransactionId);
    expect(loaded?.status).toBe('approved');
    expect(paymentEventPublisher.getPublishedEvents().map((event) => event.type)).toEqual([
      'payment.intent_created',
      'payment.approved',
    ]);
  });

  it('creates and rejects a payment from provider response', async () => {
    const paymentRepository = new PaymentRepositoryMemory();
    const paymentEventPublisher = new PaymentEventPublisherMemory();
    const paymentProvider = new PaymentProviderFake({
      resultStatus: 'rejected',
      transactionIdFactory: () => externalTransactionId,
      clock,
    });

    await createPaymentIntent(
      { paymentRepository, paymentEventPublisher, clock, observability: silentObservability },
      makeCreatePaymentIntentInput(),
    );

    const rejected = await rejectPayment(
      {
        paymentRepository,
        paymentProvider,
        paymentEventPublisher,
        clock,
        observability: silentObservability,
      },
      { paymentId },
    );

    expect(rejected.status).toBe('rejected');
    expect(rejected.externalTransaction?.status).toBe('rejected');
    expect(paymentEventPublisher.getPublishedEvents().map((event) => event.type)).toEqual([
      'payment.intent_created',
      'payment.rejected',
    ]);
  });

  it('does not create an intent when the charge amount differs from totalPaidCents', async () => {
    const paymentRepository = new PaymentRepositoryMemory();
    const paymentEventPublisher = new PaymentEventPublisherMemory();

    await expect(
      createPaymentIntent(
        { paymentRepository, paymentEventPublisher, clock, observability: silentObservability },
        makeCreatePaymentIntentInput({ amountToChargeCents: 8300 }),
      ),
    ).rejects.toThrow(PaymentAmountMismatchError);
  });

  it('does not approve when the provider returns a different amount', async () => {
    const paymentRepository = new PaymentRepositoryMemory();
    const paymentEventPublisher = new PaymentEventPublisherMemory();
    const paymentProvider = new PaymentProviderFake({
      transactionIdFactory: () => externalTransactionId,
      transactionAmountCents: 8500,
      clock,
    });

    await createPaymentIntent(
      { paymentRepository, paymentEventPublisher, clock, observability: silentObservability },
      makeCreatePaymentIntentInput(),
    );

    await expect(
      approvePayment(
        {
          paymentRepository,
          paymentProvider,
          paymentEventPublisher,
          clock,
          observability: silentObservability,
        },
        { paymentId },
      ),
    ).rejects.toThrow(PaymentAmountMismatchError);
  });

  it('does not approve a rejected payment', async () => {
    const paymentRepository = new PaymentRepositoryMemory();
    const paymentEventPublisher = new PaymentEventPublisherMemory();
    const rejectedProvider = new PaymentProviderFake({
      resultStatus: 'rejected',
      transactionIdFactory: () => externalTransactionId,
      clock,
    });
    const approvedProvider = new PaymentProviderFake({
      transactionIdFactory: () => externalTransactionId,
      clock,
    });

    await createPaymentIntent(
      { paymentRepository, paymentEventPublisher, clock, observability: silentObservability },
      makeCreatePaymentIntentInput(),
    );
    await rejectPayment(
      {
        paymentRepository,
        paymentProvider: rejectedProvider,
        paymentEventPublisher,
        clock,
        observability: silentObservability,
      },
      { paymentId },
    );

    await expect(
      approvePayment(
        {
          paymentRepository,
          paymentProvider: approvedProvider,
          paymentEventPublisher,
          clock,
          observability: silentObservability,
        },
        { paymentId },
      ),
    ).rejects.toThrow(PaymentInvalidStatusTransitionError);
  });

  it('does not reject an approved payment', async () => {
    const paymentRepository = new PaymentRepositoryMemory();
    const paymentEventPublisher = new PaymentEventPublisherMemory();
    const approvedProvider = new PaymentProviderFake({
      transactionIdFactory: () => externalTransactionId,
      clock,
    });
    const rejectedProvider = new PaymentProviderFake({
      resultStatus: 'rejected',
      transactionIdFactory: () => externalTransactionId,
      clock,
    });

    await createPaymentIntent(
      { paymentRepository, paymentEventPublisher, clock, observability: silentObservability },
      makeCreatePaymentIntentInput(),
    );
    await approvePayment(
      {
        paymentRepository,
        paymentProvider: approvedProvider,
        paymentEventPublisher,
        clock,
        observability: silentObservability,
      },
      { paymentId },
    );

    await expect(
      rejectPayment(
        {
          paymentRepository,
          paymentProvider: rejectedProvider,
          paymentEventPublisher,
          clock,
          observability: silentObservability,
        },
        { paymentId },
      ),
    ).rejects.toThrow(PaymentInvalidStatusTransitionError);
  });

  it('throws PaymentNotFoundError when approving a missing payment', async () => {
    const paymentRepository = new PaymentRepositoryMemory();
    const paymentEventPublisher = new PaymentEventPublisherMemory();
    const paymentProvider = new PaymentProviderFake({
      transactionIdFactory: () => externalTransactionId,
      clock,
    });

    await expect(
      approvePayment(
        {
          paymentRepository,
          paymentProvider,
          paymentEventPublisher,
          clock,
          observability: silentObservability,
        },
        { paymentId },
      ),
    ).rejects.toThrow(PaymentNotFoundError);
  });

  it('throws PaymentsInvalidInputError when querying an invalid payment id', async () => {
    const paymentRepository = new PaymentRepositoryMemory();

    await expect(
      getPaymentById(
        { paymentRepository, observability: silentObservability },
        { paymentId: 'not-a-uuid' },
      ),
    ).rejects.toThrow(PaymentsInvalidInputError);
  });
});
