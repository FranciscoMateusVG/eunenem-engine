import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';
import type { Database } from '../database.js';
import type { ResgatePendenteRepository } from './resgate-pendente-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'resgates_pendentes',
} as const;

export class ResgatePendenteRepositoryPostgres implements ResgatePendenteRepository {
  constructor(private readonly db: Database) {}

  async marcarPendente(idUsuario: IdUsuario, pendenteDesde: Date, criadoEm: Date): Promise<void> {
    return tracer.startActiveSpan('db.resgates_pendentes.marcarPendente', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        // 1:1 upsert keyed by id_usuario. `pendente_desde` is refreshed on
        // every marca; `criado_em` records the FIRST time the marker was set
        // and is preserved across subsequent upserts.
        await this.db
          .insertInto('resgates_pendentes')
          .values({ id_usuario: idUsuario, pendente_desde: pendenteDesde, criado_em: criadoEm })
          .onConflict((oc) =>
            oc.column('id_usuario').doUpdateSet({ pendente_desde: pendenteDesde }),
          )
          .execute();
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

  async limparPendente(idUsuario: IdUsuario): Promise<void> {
    return tracer.startActiveSpan('db.resgates_pendentes.limparPendente', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        // Idempotent: deleting an absent marker is a no-op.
        await this.db
          .deleteFrom('resgates_pendentes')
          .where('id_usuario', '=', idUsuario)
          .execute();
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

  async obterPendenteDesde(idUsuario: IdUsuario): Promise<Date | null> {
    return tracer.startActiveSpan('db.resgates_pendentes.obterPendenteDesde', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('resgates_pendentes')
          .select('pendente_desde')
          .where('id_usuario', '=', idUsuario)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? row.pendente_desde : null;
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
