import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Campanha, IdCampanha } from '../domain/arrecadacao-campanha.js';
import type { CampanhaRepository } from './arrecadacao-campanha-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'arrecadacao_campanhas',
} as const;

export class CampanhaRepositoryMemory implements CampanhaRepository {
  private readonly campanhas = new Map<IdCampanha, Campanha>();

  async save(campanha: Campanha): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        this.campanhas.set(campanha.id, campanha);
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

  async findById(id: IdCampanha): Promise<Campanha | undefined> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.campanhas.get(id);
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
