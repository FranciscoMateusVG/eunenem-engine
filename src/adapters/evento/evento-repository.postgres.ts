import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  criarEvento as criarEventoDominio,
  type Evento,
} from '../../domain/evento/entities/evento.js';
import type { IdCampanha, IdEvento } from '../../domain/evento/value-objects/ids.js';
import type { Database } from '../database.js';
import type { EventoRepository } from './evento-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'eventos',
} as const;

export class EventoRepositoryPostgres implements EventoRepository {
  constructor(private readonly db: Database) {}

  async save(evento: Evento): Promise<void> {
    return tracer.startActiveSpan('db.eventos.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        await this.db
          .insertInto('eventos')
          .values({
            id: evento.id,
            id_campanha: evento.idCampanha,
            tipo_evento: evento.tipoEvento,
            modalidade: evento.modalidade,
            data_hora: evento.dataHora,
            endereco: evento.endereco,
            criado_em: evento.criadoEm,
            atualizado_em: evento.atualizadoEm,
          })
          .onConflict((oc) =>
            oc.column('id').doUpdateSet({
              id_campanha: evento.idCampanha,
              tipo_evento: evento.tipoEvento,
              modalidade: evento.modalidade,
              data_hora: evento.dataHora,
              endereco: evento.endereco,
              atualizado_em: evento.atualizadoEm,
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

  async findById(id: IdEvento): Promise<Evento | undefined> {
    return tracer.startActiveSpan('db.eventos.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('eventos')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toEvento(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByIdCampanha(idCampanha: IdCampanha): Promise<Evento | undefined> {
    return tracer.startActiveSpan('db.eventos.findByIdCampanha', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('eventos')
          .selectAll()
          .where('id_campanha', '=', idCampanha)
          .executeTakeFirst();
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? toEvento(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async delete(id: IdEvento): Promise<void> {
    return tracer.startActiveSpan('db.eventos.delete', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        await this.db.deleteFrom('eventos').where('id', '=', id).execute();
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

function toEvento(row: {
  id: string;
  id_campanha: string;
  tipo_evento: string;
  modalidade: string;
  data_hora: Date | null;
  endereco: string | null;
  criado_em: Date;
  atualizado_em: Date;
}): Evento {
  return criarEventoDominio({
    id: row.id as IdEvento,
    idCampanha: row.id_campanha as IdCampanha,
    tipoEvento: row.tipo_evento as Evento['tipoEvento'],
    modalidade: row.modalidade as Evento['modalidade'],
    dataHora: row.data_hora as Evento['dataHora'],
    endereco: row.endereco as Evento['endereco'],
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  });
}
