import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { CampanhaPrivacidadeRepository } from './campanha-privacidade-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
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

/** Memory twin of the Postgres adapter: no entry = recados visible. */
export class CampanhaPrivacidadeRepositoryMemory implements CampanhaPrivacidadeRepository {
  private readonly exibirRecados = new Map<string, boolean>();

  async exibeRecadosPublicamente(idCampanha: IdCampanha): Promise<boolean> {
    return comSpan(
      'exibeRecadosPublicamente',
      'SELECT',
      async () => this.exibirRecados.get(idCampanha) ?? true,
    );
  }

  async definirExibirRecados(idCampanha: IdCampanha, exibir: boolean): Promise<void> {
    return comSpan('definirExibirRecados', 'UPSERT', async () => {
      this.exibirRecados.set(idCampanha, exibir);
    });
  }
}
