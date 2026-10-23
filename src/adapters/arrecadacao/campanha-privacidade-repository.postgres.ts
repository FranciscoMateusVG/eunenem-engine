import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { Database } from '../database.js';
import type { CampanhaPrivacidadeRepository } from './campanha-privacidade-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'campanha_privacidade',
} as const;

async function comSpan<T>(nome: string, operacao: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`db.campanha_privacidade.${nome}`, async (span) => {
    span.setAttributes({ ...DB_ATTRS, 'db.operation.name': operacao });
    try {
      const result = await fn();
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

export class CampanhaPrivacidadeRepositoryPostgres implements CampanhaPrivacidadeRepository {
  constructor(private readonly db: Database) {}

  async exibeRecadosPublicamente(idCampanha: IdCampanha): Promise<boolean> {
    return comSpan('exibeRecadosPublicamente', 'SELECT', async () => {
      const row = await this.db
        .selectFrom('campanha_privacidade')
        .select('exibir_recados')
        .where('campanha_id', '=', idCampanha)
        .executeTakeFirst();
      return row?.exibir_recados ?? true;
    });
  }

  async definirExibirRecados(idCampanha: IdCampanha, exibir: boolean): Promise<void> {
    return comSpan('definirExibirRecados', 'UPSERT', async () => {
      await this.db
        .insertInto('campanha_privacidade')
        .values({ campanha_id: idCampanha, exibir_recados: exibir })
        .onConflict((oc) =>
          oc
            .column('campanha_id')
            .doUpdateSet({ exibir_recados: exibir, atualizado_em: new Date() }),
        )
        .execute();
    });
  }
}
