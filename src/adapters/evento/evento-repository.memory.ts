import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Evento } from '../../domain/evento/entities/evento.js';
import type { IdCampanha, IdEvento } from '../../domain/evento/value-objects/ids.js';
import type { EventoRepository } from './evento-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'eventos',
} as const;

export class EventoRepositoryMemory implements EventoRepository {
  private readonly byId = new Map<IdEvento, Evento>();
  private readonly campanhaToEventoId = new Map<IdCampanha, IdEvento>();

  async save(evento: Evento): Promise<void> {
    return tracer.startActiveSpan('db.eventos.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        const existingForCampanha = this.campanhaToEventoId.get(evento.idCampanha);
        if (existingForCampanha !== undefined && existingForCampanha !== evento.id) {
          throw new Error(
            `Invariante 1:1 violado: campanha "${evento.idCampanha}" ja tem evento "${existingForCampanha}".`,
          );
        }
        this.byId.set(evento.id, evento);
        this.campanhaToEventoId.set(evento.idCampanha, evento.id);
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

  async findById(id: IdEvento): Promise<Evento | undefined> {
    return tracer.startActiveSpan('db.eventos.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const evento = this.byId.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return evento;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByIdCampanha(idCampanha: IdCampanha): Promise<Evento | undefined> {
    return tracer.startActiveSpan('db.eventos.findByIdCampanha', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const idEvento = this.campanhaToEventoId.get(idCampanha);
        const evento = idEvento === undefined ? undefined : this.byId.get(idEvento);
        span.setStatus({ code: SpanStatusCode.OK });
        return evento;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async delete(id: IdEvento): Promise<void> {
    return tracer.startActiveSpan('db.eventos.delete', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        const existing = this.byId.get(id);
        if (existing) {
          this.byId.delete(id);
          if (this.campanhaToEventoId.get(existing.idCampanha) === id) {
            this.campanhaToEventoId.delete(existing.idCampanha);
          }
        }
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
}
