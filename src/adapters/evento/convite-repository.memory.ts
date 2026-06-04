import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Convite } from '../../domain/evento/entities/convite.js';
import type { IdConvite, IdEvento } from '../../domain/evento/value-objects/ids.js';
import type { ConviteRepository } from './convite-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'convites',
} as const;

export class ConviteRepositoryMemory implements ConviteRepository {
  private readonly byId = new Map<IdConvite, Convite>();
  private readonly eventoToConviteId = new Map<IdEvento, IdConvite>();

  async save(convite: Convite): Promise<void> {
    return tracer.startActiveSpan('db.convites.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        const existingForEvento = this.eventoToConviteId.get(convite.idEvento);
        if (existingForEvento !== undefined && existingForEvento !== convite.id) {
          throw new Error(
            `Invariante 1:1 violado: evento "${convite.idEvento}" ja tem convite "${existingForEvento}".`,
          );
        }
        this.byId.set(convite.id, convite);
        this.eventoToConviteId.set(convite.idEvento, convite.id);
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

  async findById(id: IdConvite): Promise<Convite | undefined> {
    return tracer.startActiveSpan('db.convites.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const convite = this.byId.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return convite;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByIdEvento(idEvento: IdEvento): Promise<Convite | undefined> {
    return tracer.startActiveSpan('db.convites.findByIdEvento', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const idConvite = this.eventoToConviteId.get(idEvento);
        const convite = idConvite === undefined ? undefined : this.byId.get(idConvite);
        span.setStatus({ code: SpanStatusCode.OK });
        return convite;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async delete(id: IdConvite): Promise<void> {
    return tracer.startActiveSpan('db.convites.delete', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        const existing = this.byId.get(id);
        if (existing) {
          this.byId.delete(id);
          if (this.eventoToConviteId.get(existing.idEvento) === id) {
            this.eventoToConviteId.delete(existing.idEvento);
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
