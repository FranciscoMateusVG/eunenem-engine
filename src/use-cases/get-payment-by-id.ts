import { SpanStatusCode } from '@opentelemetry/api';
import type { PaymentRepository } from '../adapters/payment-repository.js';
import {
  type Payment,
  type PaymentCommandInput,
  PaymentCommandInputSchema,
} from '../domain/payments.js';
import { PaymentsInvalidInputError } from '../errors/payments-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface GetPaymentByIdDeps {
  readonly paymentRepository: PaymentRepository;
  readonly observability: Observability;
}

/**
 * Consulta um pagamento por ID sem acoplar o chamador ao adapter concreto.
 */
export async function getPaymentById(
  deps: GetPaymentByIdDeps,
  input: PaymentCommandInput,
): Promise<Payment | undefined> {
  const { paymentRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('getPaymentById', async (span) => {
    try {
      const parsed = PaymentCommandInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new PaymentsInvalidInputError(message);
      }

      span.setAttribute('payment.id', parsed.data.paymentId);

      const payment = await paymentRepository.findById(parsed.data.paymentId);
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
