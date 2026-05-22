import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type Campanha,
  campanhaComRecebedorAtivo,
  type IdCampanha,
} from '../../domain/arrecadacao/campanha.js';
import type { CampanhaRepository } from './campanha-repository.js';
import type { RecebedorRepository } from './recebedor-repository.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'arrecadacao_campanhas',
} as const;

export class CampanhaRepositoryMemory implements CampanhaRepository {
  private readonly campanhas = new Map<IdCampanha, Campanha>();

  constructor(private readonly recebedorRepository?: RecebedorRepository) {}

  async save(campanha: Campanha, _context?: ArrecadacaoRepositoryContext): Promise<void> {
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

  async findById(
    id: IdCampanha,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const campanha = this.campanhas.get(id);
        if (!campanha) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }

        if (!this.recebedorRepository) {
          span.setStatus({ code: SpanStatusCode.OK });
          return campanha;
        }

        const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(id);
        if (!recebedorAtivo) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return campanhaComRecebedorAtivo(campanha, recebedorAtivo);
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
