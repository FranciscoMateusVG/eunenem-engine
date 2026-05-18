import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Contribuicao, IdContribuicao } from '../../domain/arrecadacao/contribuicao.js';
import { ArrecadacaoContribuicaoJaExisteError } from '../../errors/arrecadacao/contribuicao-ja-existe.error.js';
import type { ContribuicaoRepository } from './contribuicao-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'arrecadacao_contribuicoes',
} as const;

export class ContribuicaoRepositoryMemory implements ContribuicaoRepository {
  private readonly contribuicoes = new Map<IdContribuicao, Contribuicao>();

  async save(contribuicao: Contribuicao): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        if (this.contribuicoes.has(contribuicao.id)) {
          throw new ArrecadacaoContribuicaoJaExisteError(contribuicao.id);
        }
        this.contribuicoes.set(contribuicao.id, contribuicao);
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

  async findById(id: IdContribuicao): Promise<Contribuicao | undefined> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.contribuicoes.get(id);
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
