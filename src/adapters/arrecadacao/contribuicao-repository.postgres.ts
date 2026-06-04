import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import type {
  IdCampanha,
  IdContribuicao,
  IdOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { Database } from '../database.js';
import type { ContribuicaoRepository } from './contribuicao-repository.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'arrecadacao_contribuicoes',
} as const;

/**
 * Plan 0015 / migration 019: status + contribuinte_{nome,email} dropped.
 * Row shape is now the slot definition only — admin-owned, no visitor
 * data, no FSM. The "indisponivel" badge is derived at query time by
 * checking pagamentos.
 */
type ContribuicaoRow = {
  id: string;
  campanha_id: string;
  id_opcao_contribuicao: string;
  nome: string;
  valor: number;
  imagem_url: string | null;
  grupo: string | null;
  criada_em: Date;
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
            criada_em: contribuicao.criadaEm,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              nome: contribuicao.nome,
              valor: contribuicao.valor,
              imagem_url: contribuicao.imagemUrl,
              grupo: contribuicao.grupo,
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

  /**
   * Bulk insert via Kysely (aperture-d6atj fix-up). Compiles down to a
   * single `INSERT INTO contribuicoes (...) VALUES (...), (...), ...`
   * statement — UMA round-trip, all-or-nothing.
   *
   * Empty input is a no-op (Kysely's `.values([])` rejects an empty array;
   * we short-circuit before producing SQL).
   *
   * Honra `context.trx` se fornecido — permite que o caller component este
   * INSERT junto com outras mutations em uma única transação.
   */
  async saveBulk(
    contribuicoes: readonly Contribuicao[],
    context?: ArrecadacaoRepositoryContext,
  ): Promise<void> {
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
        const executor = context?.trx ?? this.db;
        await executor
          .insertInto('contribuicoes')
          .values(
            contribuicoes.map((c) => ({
              id: c.id,
              campanha_id: c.idCampanha,
              id_opcao_contribuicao: c.idOpcaoContribuicao,
              nome: c.nome,
              valor: c.valor,
              imagem_url: c.imagemUrl,
              grupo: c.grupo,
              criada_em: c.criadaEm,
            })),
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
  return {
    id: row.id,
    idCampanha: row.campanha_id,
    idOpcaoContribuicao: row.id_opcao_contribuicao,
    nome: row.nome,
    valor: row.valor,
    imagemUrl: row.imagem_url,
    grupo: row.grupo,
    criadaEm: row.criada_em,
  };
}
