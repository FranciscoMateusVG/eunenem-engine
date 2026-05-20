import { SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  Campanha,
  DadosRecebedor,
  IdCampanha,
  IdConta,
  IdRecebedor,
  OpcaoContribuicao,
  TipoChavePix,
  TipoOpcaoContribuicao,
} from '../../domain/arrecadacao/campanha.js';
import type { Database } from '../database.js';
import type { CampanhaRepository } from './campanha-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'arrecadacao_campanhas',
} as const;

type CampanhaRow = {
  id: string;
  id_recebedor: string;
  titulo: string;
  criada_em: Date;
  recebedor_nome_titular: string;
  recebedor_tipo_chave_pix: string;
  recebedor_chave_pix: string;
};

type AdminRow = { campanha_id: string; id_usuario: string };
type OpcaoRow = { id: string; campanha_id: string; tipo: string };

/**
 * PostgreSQL CampanhaRepository: upsert da campanha, sync de administradores (delete-all + insert)
 * e upsert de opções por id (preserva opções referenciadas por contribuições).
 */
export class CampanhaRepositoryPostgres implements CampanhaRepository {
  constructor(private readonly db: Database) {}

  async save(campanha: Campanha): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        await this.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('campanhas')
            .values({
              id: campanha.id,
              id_recebedor: campanha.idRecebedor,
              titulo: campanha.titulo,
              criada_em: campanha.criadaEm,
              recebedor_nome_titular: campanha.dadosRecebedor.nomeTitular,
              recebedor_tipo_chave_pix: campanha.dadosRecebedor.tipoChavePix,
              recebedor_chave_pix: campanha.dadosRecebedor.chavePix,
            })
            .onConflict((oc) =>
              oc.column('id').doUpdateSet({
                titulo: campanha.titulo,
                recebedor_nome_titular: campanha.dadosRecebedor.nomeTitular,
                recebedor_tipo_chave_pix: campanha.dadosRecebedor.tipoChavePix,
                recebedor_chave_pix: campanha.dadosRecebedor.chavePix,
              }),
            )
            .execute();

          await trx
            .deleteFrom('campanha_administradores')
            .where('campanha_id', '=', campanha.id)
            .execute();

          if (campanha.idsAdministradores.length > 0) {
            await trx
              .insertInto('campanha_administradores')
              .values(
                campanha.idsAdministradores.map((idUsuario) => ({
                  campanha_id: campanha.id,
                  id_usuario: idUsuario,
                })),
              )
              .execute();
          }

          for (const opcao of campanha.opcoes) {
            await trx
              .insertInto('opcoes_contribuicao')
              .values({
                id: opcao.id,
                campanha_id: campanha.id,
                tipo: opcao.tipo,
              })
              .onConflict((oc) =>
                oc.column('id').doUpdateSet({
                  tipo: opcao.tipo,
                  campanha_id: campanha.id,
                }),
              )
              .execute();
          }
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

  async findById(id: IdCampanha): Promise<Campanha | undefined> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('campanhas')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();

        if (!row) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }

        const admins = await this.db
          .selectFrom('campanha_administradores')
          .selectAll()
          .where('campanha_id', '=', id)
          .execute();

        const opcoes = await this.db
          .selectFrom('opcoes_contribuicao')
          .selectAll()
          .where('campanha_id', '=', id)
          .execute();

        span.setStatus({ code: SpanStatusCode.OK });
        return toCampanha(row, admins, opcoes);
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

function toCampanha(row: CampanhaRow, admins: AdminRow[], opcoes: OpcaoRow[]): Campanha {
  const dadosRecebedor: DadosRecebedor = {
    nomeTitular: row.recebedor_nome_titular,
    tipoChavePix: row.recebedor_tipo_chave_pix as TipoChavePix,
    chavePix: row.recebedor_chave_pix,
  };

  return {
    id: row.id as IdCampanha,
    idsAdministradores: admins.map((a) => a.id_usuario as IdConta),
    idRecebedor: row.id_recebedor as IdRecebedor,
    dadosRecebedor,
    titulo: row.titulo,
    opcoes: opcoes.map(toOpcao),
    criadaEm: row.criada_em,
  };
}

function toOpcao(row: OpcaoRow): OpcaoContribuicao {
  return {
    id: row.id,
    tipo: row.tipo as TipoOpcaoContribuicao,
  };
}
