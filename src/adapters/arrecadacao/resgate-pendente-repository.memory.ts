import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { ResgatePendenteRepository } from './resgate-pendente-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'resgates_pendentes',
} as const;

interface MarcadorPendente {
  pendenteDesde: Date;
  criadoEm: Date;
}

export class ResgatePendenteRepositoryMemory implements ResgatePendenteRepository {
  private readonly marcadores = new Map<IdCampanha, MarcadorPendente>();

  async marcarPendente(idCampanha: IdCampanha, pendenteDesde: Date, criadoEm: Date): Promise<void> {
    return tracer.startActiveSpan('db.resgates_pendentes.marcarPendente', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        // Mirror the Postgres 1:1 upsert: `criadoEm` is preserved across
        // re-marcas; `pendenteDesde` is refreshed.
        const existing = this.marcadores.get(idCampanha);
        this.marcadores.set(idCampanha, {
          pendenteDesde,
          criadoEm: existing?.criadoEm ?? criadoEm,
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

  async limparPendente(idCampanha: IdCampanha): Promise<void> {
    return tracer.startActiveSpan('db.resgates_pendentes.limparPendente', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        this.marcadores.delete(idCampanha);
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

  async obterPendenteDesde(idCampanha: IdCampanha): Promise<Date | null> {
    return tracer.startActiveSpan('db.resgates_pendentes.obterPendenteDesde', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.marcadores.get(idCampanha);
        span.setStatus({ code: SpanStatusCode.OK });
        return result ? result.pendenteDesde : null;
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
