import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import type {
  IdCampanha,
  IdContribuicao,
  IdOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { Database } from '../database.js';
import type { ContribuicaoRepository } from './contribuicao-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'arrecadacao_contribuicoes',
} as const;

type ContribuicaoRow = {
  id: string;
  campanha_id: string;
  id_opcao_contribuicao: string;
  nome: string;
  valor: number;
  imagem_url: string | null;
  grupo: string | null;
  status: string;
  criada_em: Date;
  contribuinte_nome: string | null;
  contribuinte_email: string | null;
};

export class ContribuicaoRepositoryPostgres implements ContribuicaoRepository {
  constructor(private readonly db: Database) {}

  async save(contribuicao: Contribuicao): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        await this.db
          .insertInto('contribuicoes')
          .values({
            id: contribuicao.id,
            campanha_id: contribuicao.idCampanha,
            id_opcao_contribuicao: contribuicao.idOpcaoContribuicao,
            nome: contribuicao.nome,
            valor: contribuicao.valor,
            imagem_url: contribuicao.imagemUrl,
            grupo: contribuicao.grupo,
            status: contribuicao.status,
            criada_em: contribuicao.criadaEm,
            contribuinte_nome: contribuicao.contribuinte?.nome ?? null,
            contribuinte_email: contribuicao.contribuinte?.email ?? null,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              nome: contribuicao.nome,
              valor: contribuicao.valor,
              imagem_url: contribuicao.imagemUrl,
              grupo: contribuicao.grupo,
              status: contribuicao.status,
              contribuinte_nome: contribuicao.contribuinte?.nome ?? null,
              contribuinte_email: contribuicao.contribuinte?.email ?? null,
            }),
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

  async findById(id: IdContribuicao): Promise<Contribuicao | undefined> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('contribuicoes')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toContribuicao(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByCampanhaId(idCampanha: IdCampanha): Promise<readonly Contribuicao[]> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.findByCampanhaId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const rows = await this.db
          .selectFrom('contribuicoes')
          .selectAll()
          .where('campanha_id', '=', idCampanha)
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
        return rows.map(toContribuicao);
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
        const rows = await this.db
          .selectFrom('contribuicoes')
          .selectAll()
          .where('campanha_id', '=', idCampanha)
          .where('id_opcao_contribuicao', '=', idOpcao)
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
        return rows.map(toContribuicao);
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
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        await this.db.deleteFrom('contribuicoes').where('id', '=', id).execute();
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
        const row = await this.db
          .selectFrom('contribuicoes')
          .select((eb) => eb.fn.countAll<string>().as('total'))
          .where('campanha_id', '=', idCampanha)
          .where('id_opcao_contribuicao', '=', idOpcao)
          .executeTakeFirstOrThrow();
        span.setStatus({ code: SpanStatusCode.OK });
        return Number(row.total);
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

function toContribuicao(row: ContribuicaoRow): Contribuicao {
  const contribuinte =
    row.contribuinte_nome !== null && row.contribuinte_email !== null
      ? {
          nome: row.contribuinte_nome,
          email: row.contribuinte_email,
        }
      : null;

  return {
    id: row.id,
    idCampanha: row.campanha_id,
    idOpcaoContribuicao: row.id_opcao_contribuicao,
    nome: row.nome,
    valor: row.valor,
    imagemUrl: row.imagem_url,
    grupo: row.grupo,
    contribuinte,
    status: row.status as Contribuicao['status'],
    criadaEm: row.criada_em,
  };
}
