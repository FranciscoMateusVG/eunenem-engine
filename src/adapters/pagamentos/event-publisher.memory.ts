import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { EventoPagamento } from '../../domain/pagamentos/value-objects/evento-pagamento.js';
import type { PagamentoEventPublisher } from './event-publisher.js';

const tracer = trace.getTracer('frame');

export class PagamentoEventPublisherMemory implements PagamentoEventPublisher {
  private readonly eventos: EventoPagamento[] = [];

  async publish(evento: EventoPagamento): Promise<void> {
    return tracer.startActiveSpan('events.pagamentos.publish', async (span) => {
      span.setAttribute('event.type', evento.tipo);
      span.setAttribute('payment.id', evento.idPagamento);

      try {
        this.eventos.push(evento);
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

  getEventosPublicados(): readonly EventoPagamento[] {
    return [...this.eventos];
  }
}
