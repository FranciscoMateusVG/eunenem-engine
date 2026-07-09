import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Transaction } from 'kysely';
import {
  type Convidado,
  criarListaDeConvidados as criarListaDeConvidadosDominio,
  type ListaDeConvidados,
} from '../../domain/evento/entities/lista-de-convidados.js';
import type {
  IdConvidado,
  IdEvento,
  IdListaDeConvidados,
} from '../../domain/evento/value-objects/ids.js';
import type { StatusPresencaConvidado } from '../../domain/evento/value-objects/status-presenca-convidado.js';
import type { Database } from '../database.js';
import type { DB } from '../db-types.generated.js';
import type { ListaDeConvidadosRepository } from './lista-de-convidados-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'listas_de_convidados',
} as const;

type DbExecutor = Database | Transaction<DB>;

type ListaRow = {
  id: string;
  id_evento: string;
  formato_mensagem_convite: string;
  criado_em: Date;
  atualizado_em: Date;
};

type ConvidadoRow = {
  id: string;
  lista_id: string;
  nome: string;
  numero_celular: string;
  presenca: string;
};

export class ListaDeConvidadosRepositoryPostgres implements ListaDeConvidadosRepository {
  constructor(private readonly db: Database) {}

  async save(listaDeConvidados: ListaDeConvidados): Promise<void> {
    return tracer.startActiveSpan('db.listasDeConvidados.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        await this.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('listas_de_convidados')
            .values({
              id: listaDeConvidados.id,
              id_evento: listaDeConvidados.idEvento,
              formato_mensagem_convite: listaDeConvidados.formatoMensagemConvite,
              criado_em: listaDeConvidados.criadoEm,
              atualizado_em: listaDeConvidados.atualizadoEm,
            })
            .onConflict((oc) =>
              oc.column('id').doUpdateSet({
                id_evento: listaDeConvidados.idEvento,
                formato_mensagem_convite: listaDeConvidados.formatoMensagemConvite,
                atualizado_em: listaDeConvidados.atualizadoEm,
              }),
            )
            .execute();

          await trx.deleteFrom('convidados').where('lista_id', '=', listaDeConvidados.id).execute();

          if (listaDeConvidados.convidados.length > 0) {
            await trx
              .insertInto('convidados')
              .values(
                listaDeConvidados.convidados.map((convidado) => ({
                  id: convidado.id,
                  lista_id: listaDeConvidados.id,
                  nome: convidado.nome,
                  numero_celular: convidado.numeroCelular,
                  presenca: convidado.presenca,
                })),
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

  async findById(id: IdListaDeConvidados): Promise<ListaDeConvidados | undefined> {
    return tracer.startActiveSpan('db.listasDeConvidados.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const lista = await this.findHydratedBy('id', id, this.db);
        span.setStatus({ code: SpanStatusCode.OK });
        return lista;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByIdEvento(idEvento: IdEvento): Promise<ListaDeConvidados | undefined> {
    return tracer.startActiveSpan('db.listasDeConvidados.findByIdEvento', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const lista = await this.findHydratedBy('id_evento', idEvento, this.db);
        span.setStatus({ code: SpanStatusCode.OK });
        return lista;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByConvidadoId(idConvidado: IdConvidado): Promise<ListaDeConvidados | undefined> {
    return tracer.startActiveSpan('db.listasDeConvidados.findByConvidadoId', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        // aperture-rvhlt: a convidado belongs to exactly one lista
        // (convidados.lista_id FK) — resolve the lista_id, then reuse the
        // hydrating loader so the returned aggregate is shaped identically
        // to every other read path.
        const row = await this.db
          .selectFrom('convidados')
          .select('lista_id')
          .where('id', '=', idConvidado)
          .executeTakeFirst();
        if (!row) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        const lista = await this.findHydratedBy('id', row.lista_id, this.db);
        span.setStatus({ code: SpanStatusCode.OK });
        return lista;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async alterarPresencaConvidado(
    id: IdListaDeConvidados,
    idConvidado: IdConvidado,
    presenca: StatusPresencaConvidado,
    atualizadoEm: Date,
  ): Promise<ListaDeConvidados | undefined> {
    return tracer.startActiveSpan(
      'db.listasDeConvidados.alterarPresencaConvidado',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          const updated = await this.db.transaction().execute(async (trx) => {
            const existing = await trx
              .selectFrom('listas_de_convidados')
              .select('id')
              .where('id', '=', id)
              .executeTakeFirst();

            if (!existing) {
              return undefined;
            }

            await trx
              .updateTable('convidados')
              .set({ presenca })
              .where('lista_id', '=', id)
              .where('id', '=', idConvidado)
              .execute();

            await trx
              .updateTable('listas_de_convidados')
              .set({ atualizado_em: atualizadoEm })
              .where('id', '=', id)
              .execute();

            return this.findHydratedBy('id', id, trx);
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return updated;
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

  async delete(id: IdListaDeConvidados): Promise<void> {
    return tracer.startActiveSpan('db.listasDeConvidados.delete', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        await this.db.deleteFrom('listas_de_convidados').where('id', '=', id).execute();
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

  private async findHydratedBy(
    column: 'id' | 'id_evento',
    value: string,
    executor: DbExecutor,
  ): Promise<ListaDeConvidados | undefined> {
    const row = await executor
      .selectFrom('listas_de_convidados')
      .selectAll()
      .where(column, '=', value)
      .executeTakeFirst();

    if (!row) {
      return undefined;
    }

    const convidados = await executor
      .selectFrom('convidados')
      .selectAll()
      .where('lista_id', '=', row.id)
      .orderBy('nome', 'asc')
      .orderBy('id', 'asc')
      .execute();

    return toListaDeConvidados(row as ListaRow, convidados as ConvidadoRow[]);
  }
}

function toListaDeConvidados(
  row: ListaRow,
  convidados: readonly ConvidadoRow[],
): ListaDeConvidados {
  return criarListaDeConvidadosDominio({
    id: row.id as IdListaDeConvidados,
    idEvento: row.id_evento as IdEvento,
    formatoMensagemConvite:
      row.formato_mensagem_convite as ListaDeConvidados['formatoMensagemConvite'],
    convidados: convidados.map(toConvidado),
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  });
}

function toConvidado(row: ConvidadoRow): Convidado {
  return {
    id: row.id as IdConvidado,
    nome: row.nome as Convidado['nome'],
    numeroCelular: row.numero_celular as Convidado['numeroCelular'],
    presenca: row.presenca as Convidado['presenca'],
  };
}
