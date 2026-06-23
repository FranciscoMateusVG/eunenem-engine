import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { PerfilCriador } from '../../domain/usuario/entities/perfil-criador.js';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { PerfilCriadorRepository } from './perfil-criador-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'perfil_criadores',
} as const;

export class PerfilCriadorRepositoryMemory implements PerfilCriadorRepository {
  private readonly perfis = new Map<IdUsuario, PerfilCriador>();

  async save(perfil: PerfilCriador): Promise<void> {
    return tracer.startActiveSpan('db.perfil_criadores.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        // Mirror the Postgres 1:1 upsert: an existing profile's `id` and
        // `criadoEm` are preserved; everything else is overwritten.
        const existing = this.perfis.get(perfil.idUsuario);
        this.perfis.set(perfil.idUsuario, {
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

  async findByUsuarioId(idUsuario: IdUsuario): Promise<PerfilCriador | undefined> {
    return tracer.startActiveSpan('db.perfil_criadores.findByUsuarioId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.perfis.get(idUsuario);
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
