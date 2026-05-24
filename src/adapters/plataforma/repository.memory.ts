import { SpanStatusCode, trace } from '@opentelemetry/api';
import { criarPlataforma, type Plataforma } from '../../domain/plataforma/entities/plataforma.js';
import type { IdPlataforma } from '../../domain/plataforma/value-objects/ids.js';
import type { SlugPlataforma } from '../../domain/plataforma/value-objects/slug-plataforma.js';
import type { PlataformaRepository } from './repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'plataformas',
} as const;

/** UUIDs determinísticos para as plataformas seed. Estáveis através de runs. */
export const ID_PLATAFORMA_EUNENEM: IdPlataforma = '11111111-1111-4111-8111-111111111111';
export const ID_PLATAFORMA_EUCASEI: IdPlataforma = '22222222-2222-4222-8222-222222222222';

const SEED_DATE = new Date('2026-01-01T00:00:00.000Z');

export const PLATAFORMAS_SEED: readonly Plataforma[] = [
  criarPlataforma({
    id: ID_PLATAFORMA_EUNENEM,
    slug: 'eunenem' as SlugPlataforma,
    nome: 'EuNenem',
    criadaEm: SEED_DATE,
  }),
  criarPlataforma({
    id: ID_PLATAFORMA_EUCASEI,
    slug: 'eucasei' as SlugPlataforma,
    nome: 'EuCasei',
    criadaEm: SEED_DATE,
  }),
];

export class PlataformaRepositoryMemory implements PlataformaRepository {
  private readonly plataformas: Map<IdPlataforma, Plataforma>;

  constructor(seed: readonly Plataforma[] = PLATAFORMAS_SEED) {
    this.plataformas = new Map(seed.map((p) => [p.id, p]));
  }

  async findById(id: IdPlataforma): Promise<Plataforma | undefined> {
    return tracer.startActiveSpan('db.plataformas.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.plataformas.get(id);
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

  async findBySlug(slug: SlugPlataforma): Promise<Plataforma | undefined> {
    return tracer.startActiveSpan('db.plataformas.findBySlug', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = [...this.plataformas.values()].find((p) => p.slug === slug);
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

  async listAtivas(): Promise<readonly Plataforma[]> {
    return tracer.startActiveSpan('db.plataformas.listAtivas', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = [...this.plataformas.values()];
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
