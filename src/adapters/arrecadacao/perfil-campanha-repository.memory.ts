import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { PerfilCampanha } from '../../domain/arrecadacao/entities/perfil-campanha.js';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { PerfilCampanhaRepository } from './perfil-campanha-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'perfil_campanhas',
} as const;

export class PerfilCampanhaRepositoryMemory implements PerfilCampanhaRepository {
  private readonly perfis = new Map<IdCampanha, PerfilCampanha>();

  async save(perfil: PerfilCampanha): Promise<void> {
    return tracer.startActiveSpan('db.perfil_campanhas.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        // Mirror the Postgres 1:1 upsert: an existing profile's `id` and
        // `criadoEm` are preserved; everything else is overwritten.
        const existing = this.perfis.get(perfil.idCampanha);
        this.perfis.set(perfil.idCampanha, {
          ...perfil,
          id: existing?.id ?? perfil.id,
          criadoEm: existing?.criadoEm ?? perfil.criadoEm,
        });
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

  async findByIdCampanha(idCampanha: IdCampanha): Promise<PerfilCampanha | undefined> {
    return tracer.startActiveSpan('db.perfil_campanhas.findByIdCampanha', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.perfis.get(idCampanha);
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
