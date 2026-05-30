import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type Campanha,
  campanhaComRecebedorAtivo,
  campanhaSemRecebedor,
} from '../../domain/arrecadacao/entities/campanha.js';
import type {
  IdCampanha,
  IdConta,
  IdPlataformaReferencia,
} from '../../domain/arrecadacao/value-objects/ids.js';
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
        span.setStatus({ code: SpanStatusCode.OK });
        return recebedorAtivo
          ? campanhaComRecebedorAtivo(campanha, recebedorAtivo)
          : campanhaSemRecebedor(campanha);
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByPlataforma(
    idPlataforma: IdPlataformaReferencia,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Campanha[]> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findByPlataforma', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const campanhasDaPlataforma = [...this.campanhas.values()].filter(
          (c) => c.idPlataforma === idPlataforma,
        );

        if (!this.recebedorRepository) {
          span.setStatus({ code: SpanStatusCode.OK });
          return campanhasDaPlataforma;
        }

        const resultados: Campanha[] = [];
        for (const campanha of campanhasDaPlataforma) {
          const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(campanha.id);
          resultados.push(
            recebedorAtivo
              ? campanhaComRecebedorAtivo(campanha, recebedorAtivo)
              : campanhaSemRecebedor(campanha),
          );
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return resultados;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findFirstByAdministrador(
    idConta: IdConta,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined> {
    return tracer.startActiveSpan(
      'db.arrecadacao_campanhas.findFirstByAdministrador',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          // Deterministic ordering by criadaEm ASC (oldest first) — matches
          // the Postgres adapter contract so callers see a stable result.
          const matches = [...this.campanhas.values()]
            .filter((c) => c.idsAdministradores.includes(idConta))
            .sort((a, b) => a.criadaEm.getTime() - b.criadaEm.getTime());

          const first = matches[0];
          if (!first) {
            span.setStatus({ code: SpanStatusCode.OK });
            return undefined;
          }

          if (!this.recebedorRepository) {
            span.setStatus({ code: SpanStatusCode.OK });
            return first;
          }

          const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(first.id);
          span.setStatus({ code: SpanStatusCode.OK });
          return recebedorAtivo
            ? campanhaComRecebedorAtivo(first, recebedorAtivo)
            : campanhaSemRecebedor(first);
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

  async delete(idCampanha: IdCampanha, _context?: ArrecadacaoRepositoryContext): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.delete', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        // Idempotent — no-op if id is unknown.
        this.campanhas.delete(idCampanha);
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
