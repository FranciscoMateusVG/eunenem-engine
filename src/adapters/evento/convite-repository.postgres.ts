import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type Convite,
  criarConvite as criarConviteDominio,
} from '../../domain/evento/entities/convite.js';
import type { IdConvite, IdEvento } from '../../domain/evento/value-objects/ids.js';
import type { Database } from '../database.js';
import type { ConviteRepository } from './convite-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'convites',
} as const;

export class ConviteRepositoryPostgres implements ConviteRepository {
  constructor(private readonly db: Database) {}

  async save(convite: Convite): Promise<void> {
    return tracer.startActiveSpan('db.convites.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        await this.db
          .insertInto('convites')
          .values({
            id: convite.id,
            id_evento: convite.idEvento,
            remetente: convite.remetente,
            nome_exibido: convite.nomeExibido,
            mensagem: convite.mensagem,
            paleta: convite.paleta,
            fonte: convite.fonte,
            modelo: convite.modelo,
            imagem_url: convite.imagemUrl ?? null,
            criado_em: convite.criadoEm,
            atualizado_em: convite.atualizadoEm,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              id_evento: convite.idEvento,
              remetente: convite.remetente,
              nome_exibido: convite.nomeExibido,
              mensagem: convite.mensagem,
              paleta: convite.paleta,
              fonte: convite.fonte,
              modelo: convite.modelo,
              imagem_url: convite.imagemUrl ?? null,
              atualizado_em: convite.atualizadoEm,
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

  async findById(id: IdConvite): Promise<Convite | undefined> {
    return tracer.startActiveSpan('db.convites.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('convites')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toConvite(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByIdEvento(idEvento: IdEvento): Promise<Convite | undefined> {
    return tracer.startActiveSpan('db.convites.findByIdEvento', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('convites')
          .selectAll()
          .where('id_evento', '=', idEvento)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toConvite(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async delete(id: IdConvite): Promise<void> {
    return tracer.startActiveSpan('db.convites.delete', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        await this.db.deleteFrom('convites').where('id', '=', id).execute();
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
}

function toConvite(row: {
  id: string;
  id_evento: string;
  remetente: string;
  nome_exibido: string;
  mensagem: string;
  paleta: string;
  fonte: string;
  modelo: string;
  imagem_url: string | null;
  criado_em: Date;
  atualizado_em: Date;
}): Convite {
  const base = {
    id: row.id as IdConvite,
    idEvento: row.id_evento as IdEvento,
    remetente: row.remetente as Convite['remetente'],
    nomeExibido: row.nome_exibido as Convite['nomeExibido'],
    mensagem: row.mensagem as Convite['mensagem'],
    paleta: row.paleta as Convite['paleta'],
    fonte: row.fonte as Convite['fonte'],
    modelo: row.modelo as Convite['modelo'],
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };

  return row.imagem_url === null
    ? criarConviteDominio(base)
    : criarConviteDominio({
        ...base,
        imagemUrl: row.imagem_url as NonNullable<Convite['imagemUrl']>,
      });
}
