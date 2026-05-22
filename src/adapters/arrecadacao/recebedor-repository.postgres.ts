import { SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  DadosRecebedor,
  IdCampanha,
  TipoChavePix,
} from '../../domain/arrecadacao/campanha.js';
import type { IdRecebedor, Recebedor } from '../../domain/arrecadacao/recebedor.js';
import type { Database } from '../database.js';
import type { RecebedorRepository } from './recebedor-repository.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'arrecadacao_recebedores',
} as const;

type RecebedorRow = {
  id: string;
  campanha_id: string;
  nome_titular: string;
  tipo_chave_pix: string;
  chave_pix: string;
  is_active: boolean;
  criada_em: Date;
};

export class RecebedorRepositoryPostgres implements RecebedorRepository {
  constructor(private readonly db: Database) {}

  async save(recebedor: Recebedor, context?: ArrecadacaoRepositoryContext): Promise<void> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan('db.arrecadacao_recebedores.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        await executor
          .insertInto('recebedores')
          .values({
            id: recebedor.id,
            campanha_id: recebedor.idCampanha,
            nome_titular: recebedor.dadosRecebedor.nomeTitular,
            tipo_chave_pix: recebedor.dadosRecebedor.tipoChavePix,
            chave_pix: recebedor.dadosRecebedor.chavePix,
            is_active: recebedor.isActive,
            criada_em: recebedor.criadaEm,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              is_active: recebedor.isActive,
              nome_titular: recebedor.dadosRecebedor.nomeTitular,
              tipo_chave_pix: recebedor.dadosRecebedor.tipoChavePix,
              chave_pix: recebedor.dadosRecebedor.chavePix,
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

  async findAtivoByCampanhaId(
    idCampanha: IdCampanha,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<Recebedor | undefined> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan(
      'db.arrecadacao_recebedores.findAtivoByCampanhaId',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const row = await executor
            .selectFrom('recebedores')
            .selectAll()
            .where('campanha_id', '=', idCampanha)
            .where('is_active', '=', true)
            .executeTakeFirst();
          span.setStatus({ code: SpanStatusCode.OK });
          return row ? toRecebedor(row) : undefined;
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

  async findByCampanhaId(
    idCampanha: IdCampanha,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Recebedor[]> {
    const executor = context?.trx ?? this.db;
    return tracer.startActiveSpan('db.arrecadacao_recebedores.findByCampanhaId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const rows = await executor
          .selectFrom('recebedores')
          .selectAll()
          .where('campanha_id', '=', idCampanha)
          .orderBy('criada_em', 'asc')
          .execute();
        span.setStatus({ code: SpanStatusCode.OK });
        return rows.map(toRecebedor);
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

function toRecebedor(row: RecebedorRow): Recebedor {
  const dadosRecebedor: DadosRecebedor = {
    nomeTitular: row.nome_titular,
    tipoChavePix: row.tipo_chave_pix as TipoChavePix,
    chavePix: row.chave_pix,
  };

  return {
    id: row.id as IdRecebedor,
    idCampanha: row.campanha_id as IdCampanha,
    dadosRecebedor,
    isActive: row.is_active,
    criadaEm: row.criada_em,
  };
}
