import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Payment, PaymentId } from '../domain/payments.js';
import { PaymentAlreadyExistsError } from '../errors/payment-already-exists.error.js';
import { PaymentNotFoundError } from '../errors/payment-not-found.error.js';
import type { PaymentRepository } from './payment-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'payments',
} as const;

export class PaymentRepositoryMemory implements PaymentRepository {
  private readonly payments = new Map<PaymentId, Payment>();

  async save(payment: Payment): Promise<void> {
    return tracer.startActiveSpan('db.payments.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        if (this.payments.has(payment.id)) {
          throw new PaymentAlreadyExistsError(payment.id, payment.intent.id);
        }

        this.payments.set(payment.id, payment);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async update(payment: Payment): Promise<void> {
    return tracer.startActiveSpan('db.payments.update', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        if (!this.payments.has(payment.id)) {
          throw new PaymentNotFoundError(payment.id);
        }

        this.payments.set(payment.id, payment);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findById(id: PaymentId): Promise<Payment | undefined> {
    return tracer.startActiveSpan('db.payments.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.payments.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
