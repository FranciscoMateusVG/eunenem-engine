import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { PaymentEventPublisher } from '../adapters/payment-event-publisher.js';
import type { PaymentRepository } from '../adapters/payment-repository.js';
import {
  type CreatePaymentIntentInput,
  CreatePaymentIntentInputSchema,
  createPaymentEvent,
  createPendingPayment,
  type Payment,
} from '../domain/payments.js';
import { PaymentAlreadyExistsError } from '../errors/payment-already-exists.error.js';
import { PaymentAmountMismatchError } from '../errors/payment-amount-mismatch.error.js';
import { PaymentsInvalidInputError } from '../errors/payments-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface CreatePaymentIntentDeps {
  readonly paymentRepository: PaymentRepository;
  readonly paymentEventPublisher: PaymentEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Cria uma intenção de pagamento sem conhecer campanha, presente, rifa ou convite.
 */
export async function createPaymentIntent(
  deps: CreatePaymentIntentDeps,
  input: CreatePaymentIntentInput,
): Promise<Payment> {
  const { paymentRepository, paymentEventPublisher, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('createPaymentIntent', async (span) => {
    try {
      const parsed = CreatePaymentIntentInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new PaymentsInvalidInputError(message);
      }

      const { paymentId, paymentIntentId, valueComposition, amountToChargeCents, method } =
        parsed.data;

      span.setAttribute('payment.id', paymentId);
      span.setAttribute('payment.intent.id', paymentIntentId);
      span.setAttribute('payment.contribution.id', valueComposition.contributionId);
      span.setAttribute('payment.amount_cents', amountToChargeCents);
      span.setAttribute('payment.method', method);

      if (amountToChargeCents !== valueComposition.totalPaidCents) {
        throw new PaymentAmountMismatchError(valueComposition.totalPaidCents, amountToChargeCents);
      }

      const existing = await paymentRepository.findById(paymentId);
      if (existing) {
        throw new PaymentAlreadyExistsError(paymentId, paymentIntentId);
      }

      const now = clock();
      const payment = createPendingPayment({
        paymentId,
        paymentIntentId,
        valueComposition,
        amountToChargeCents,
        method,
        createdAt: now,
      });

      await paymentRepository.save(payment);
      await paymentEventPublisher.publish(
        createPaymentEvent({
          id: randomUUID(),
          type: 'payment.intent_created',
          payment,
          occurredAt: now,
        }),
      );

      logger.info('payment.intent_created', {
        paymentId,
        paymentIntentId,
        contributionId: payment.intent.contributionId,
        amountCents: payment.intent.amountCents,
        method,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return payment;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
