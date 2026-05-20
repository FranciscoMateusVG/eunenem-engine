import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Contribuicao, IdContribuicao } from '../../domain/arrecadacao/contribuicao.js';
import { ArrecadacaoContribuicaoJaExisteError } from '../../errors/arrecadacao/contribuicao-ja-existe.error.js';
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
  valor: number;
  status: string;
  criada_em: Date;
  contribuinte_nome_exibicao: string;
  contribuinte_email: string;
};

export class ContribuicaoRepositoryPostgres implements ContribuicaoRepository {
  constructor(private readonly db: Database) {}

  async save(contribuicao: Contribuicao): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_contribuicoes.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        await this.db
          .insertInto('contribuicoes')
          .values({
            id: contribuicao.id,
            campanha_id: contribuicao.idCampanha,
            id_opcao_contribuicao: contribuicao.idOpcaoContribuicao,
            valor: contribuicao.valor,
            status: contribuicao.status,
            criada_em: contribuicao.criadaEm,
            contribuinte_nome_exibicao: contribuicao.contribuinte.nomeExibicao,
            contribuinte_email: contribuicao.contribuinte.email,
          })
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (isUniqueViolation(error)) {
          throw new ArrecadacaoContribuicaoJaExisteError(contribuicao.id);
        }
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
}

function toContribuicao(row: ContribuicaoRow): Contribuicao {
  return {
    id: row.id,
    idCampanha: row.campanha_id,
    idOpcaoContribuicao: row.id_opcao_contribuicao,
    valor: row.valor,
    contribuinte: {
      nomeExibicao: row.contribuinte_nome_exibicao,
      email: row.contribuinte_email,
    },
    status: row.status as Contribuicao['status'],
    criadaEm: row.criada_em,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === '23505'
  );
}
