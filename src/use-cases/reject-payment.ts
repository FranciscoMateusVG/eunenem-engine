import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { PaymentEventPublisher } from '../adapters/payment-event-publisher.js';
import type { PaymentProvider } from '../adapters/payment-provider.js';
import type { PaymentRepository } from '../adapters/payment-repository.js';
import {
  canRejectPayment,
  createPaymentEvent,
  type Payment,
  type PaymentCommandInput,
  PaymentCommandInputSchema,
  rejectPendingPayment,
} from '../domain/payments.js';
import { PaymentAmountMismatchError } from '../errors/payment-amount-mismatch.error.js';
import { PaymentInvalidStatusTransitionError } from '../errors/payment-invalid-status-transition.error.js';
import { PaymentNotFoundError } from '../errors/payment-not-found.error.js';
import { PaymentsInvalidInputError } from '../errors/payments-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface RejectPaymentDeps {
  readonly paymentRepository: PaymentRepository;
  readonly paymentProvider: PaymentProvider;
  readonly paymentEventPublisher: PaymentEventPublisher;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Rejeita um pagamento a partir de uma transação externa simulada pelo provedor fake.
 */
export async function rejectPayment(
  deps: RejectPaymentDeps,
  input: PaymentCommandInput,
): Promise<Payment> {
  const { paymentRepository, paymentProvider, paymentEventPublisher, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('rejectPayment', async (span) => {
    try {
      const parsed = PaymentCommandInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new PaymentsInvalidInputError(message);
      }

      span.setAttribute('payment.id', parsed.data.paymentId);

      const payment = await paymentRepository.findById(parsed.data.paymentId);
      if (!payment) {
        throw new PaymentNotFoundError(parsed.data.paymentId);
      }

      if (!canRejectPayment(payment)) {
        throw new PaymentInvalidStatusTransitionError(payment.id, payment.status, 'rejected');
      }

      const transaction = await paymentProvider.requestPayment({
        paymentId: payment.id,
        paymentIntentId: payment.intent.id,
        amountCents: payment.intent.amountCents,
        method: payment.intent.method,
      });

      if (transaction.status !== 'rejected') {
        throw new PaymentInvalidStatusTransitionError(payment.id, payment.status, 'rejected');
      }

      if (transaction.amountCents !== payment.intent.amountCents) {
        throw new PaymentAmountMismatchError(payment.intent.amountCents, transaction.amountCents);
      }

      const now = clock();
      const rejected = rejectPendingPayment(payment, transaction, now);
      await paymentRepository.update(rejected);
      await paymentEventPublisher.publish(
        createPaymentEvent({
          id: randomUUID(),
          type: 'payment.rejected',
          payment: rejected,
          occurredAt: now,
        }),
      );

      logger.info('payment.rejected', {
        paymentId: rejected.id,
        paymentIntentId: rejected.intent.id,
        contributionId: rejected.intent.contributionId,
        amountCents: rejected.intent.amountCents,
        externalTransactionId: transaction.id,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return rejected;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
