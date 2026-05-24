import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Recebedor } from '../../domain/arrecadacao/entities/recebedor.js';
import type { IdCampanha, IdRecebedor } from '../../domain/arrecadacao/value-objects/ids.js';
import type { RecebedorRepository } from './recebedor-repository.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'arrecadacao_recebedores',
} as const;

export class RecebedorRepositoryMemory implements RecebedorRepository {
  private readonly recebedores = new Map<IdRecebedor, Recebedor>();

  async save(recebedor: Recebedor, _context?: ArrecadacaoRepositoryContext): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_recebedores.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        this.recebedores.set(recebedor.id, recebedor);
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

  async findAtivoByCampanhaId(
    idCampanha: IdCampanha,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<Recebedor | undefined> {
    return tracer.startActiveSpan(
      'db.arrecadacao_recebedores.findAtivoByCampanhaId',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = [...this.recebedores.values()].find(
            (r) => r.idCampanha === idCampanha && r.isActive,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async findByCampanhaId(
    idCampanha: IdCampanha,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Recebedor[]> {
    return tracer.startActiveSpan('db.arrecadacao_recebedores.findByCampanhaId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = [...this.recebedores.values()].filter((r) => r.idCampanha === idCampanha);
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
