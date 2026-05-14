import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { PaymentEvent } from '../domain/payments.js';
import type { PaymentEventPublisher } from './payment-event-publisher.js';

const tracer = trace.getTracer('frame');

export class PaymentEventPublisherMemory implements PaymentEventPublisher {
  private readonly events: PaymentEvent[] = [];

  async publish(event: PaymentEvent): Promise<void> {
    return tracer.startActiveSpan('events.payments.publish', async (span) => {
      span.setAttribute('event.type', event.type);
      span.setAttribute('payment.id', event.paymentId);

      try {
        this.events.push(event);
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

  getPublishedEvents(): readonly PaymentEvent[] {
    return [...this.events];
  }
}
