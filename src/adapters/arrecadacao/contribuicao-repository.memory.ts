import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import type {
  IdCampanha,
  IdContribuicao,
  IdOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { ContribuicaoRepository } from './contribuicao-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'arrecadacao_contribuicoes',
} as const;

export class ContribuicaoRepositoryMemory implements ContribuicaoRepository {
  private readonly contribuicoes = new Map<IdContribuicao, Contribuicao>();

  private readonly arquivadas = new Set<IdContribuicao>();

  async save(contribuicao: Contribuicao): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
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

  /**
   * Bulk insert (aperture-d6atj fix-up). Memory has no real "bulk" — the
   * for-loop over single-save logic preserves the contract: same end state
   * as N `save` calls. The span (`db.arrecadacao_contribuicoes.saveBulk`,
   * attribute `batch.size: N`) matches the Postgres adapter so observability
   * is portable across environments.
   */
  async saveBulk(contribuicoes: readonly Contribuicao[]): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.saveBulk', async (span) => {
      span.setAttributes({
        ...DB_ATTRS,
        'db.operation.name': 'INSERT',
        'batch.size': contribuicoes.length,
      });
      try {
        if (contribuicoes.length === 0) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
        for (const c of contribuicoes) {
          this.contribuicoes.set(c.id, c);
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

  async findById(
    id: IdContribuicao,
    options?: { incluirArquivadas?: boolean },
  ): Promise<Contribuicao | undefined> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result =
          !options?.incluirArquivadas && this.arquivadas.has(id)
            ? undefined
            : this.contribuicoes.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return result && this.arquivadas.has(id) ? { ...result, arquivada: true } : result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByCampanhaId(
    idCampanha: IdCampanha,
    options?: { incluirArquivadas?: boolean },
  ): Promise<readonly Contribuicao[]> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.findByCampanhaId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = [...this.contribuicoes.values()].filter(
          (c) =>
            (options?.incluirArquivadas || !this.arquivadas.has(c.id)) &&
            c.idCampanha === idCampanha,
        );
        span.setStatus({ code: SpanStatusCode.OK });
        return result.map((c) => (this.arquivadas.has(c.id) ? { ...c, arquivada: true } : c));
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByOpcao(
    idCampanha: IdCampanha,
    idOpcao: IdOpcaoContribuicao,
  ): Promise<readonly Contribuicao[]> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.findByOpcao', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = [...this.contribuicoes.values()].filter(
          (c) =>
            !this.arquivadas.has(c.id) &&
            c.idCampanha === idCampanha &&
            c.idOpcaoContribuicao === idOpcao,
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
    });
  }

  async deleteById(id: IdContribuicao): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.deleteById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        if (this.contribuicoes.has(id)) this.arquivadas.add(id);
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

  async countByOpcao(idCampanha: IdCampanha, idOpcao: IdOpcaoContribuicao): Promise<number> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.countByOpcao', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        let count = 0;
        for (const c of this.contribuicoes.values()) {
          if (
            !this.arquivadas.has(c.id) &&
            c.idCampanha === idCampanha &&
            c.idOpcaoContribuicao === idOpcao
          )
            count++;
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return count;
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
