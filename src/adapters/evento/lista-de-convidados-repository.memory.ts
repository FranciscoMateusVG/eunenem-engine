import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { ListaDeConvidados } from '../../domain/evento/entities/lista-de-convidados.js';
import { listaDeConvidadosComPresencaAlterada } from '../../domain/evento/entities/lista-de-convidados.js';
import type {
  IdConvidado,
  IdEvento,
  IdListaDeConvidados,
} from '../../domain/evento/value-objects/ids.js';
import type { StatusPresencaConvidado } from '../../domain/evento/value-objects/status-presenca-convidado.js';
import type { ListaDeConvidadosRepository } from './lista-de-convidados-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'listas_de_convidados',
} as const;

export class ListaDeConvidadosRepositoryMemory implements ListaDeConvidadosRepository {
  private readonly byId = new Map<IdListaDeConvidados, ListaDeConvidados>();
  private readonly eventoToListaId = new Map<IdEvento, IdListaDeConvidados>();

  async save(listaDeConvidados: ListaDeConvidados): Promise<void> {
    return tracer.startActiveSpan('db.listasDeConvidados.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        const existingForEvento = this.eventoToListaId.get(listaDeConvidados.idEvento);
        if (existingForEvento !== undefined && existingForEvento !== listaDeConvidados.id) {
          throw new Error(
            `Invariante 1:1 violado: evento "${listaDeConvidados.idEvento}" ja tem lista "${existingForEvento}".`,
          );
        }
        this.byId.set(listaDeConvidados.id, listaDeConvidados);
        this.eventoToListaId.set(listaDeConvidados.idEvento, listaDeConvidados.id);
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
        const lista = this.byId.get(id);
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
        const idLista = this.eventoToListaId.get(idEvento);
        const lista = idLista === undefined ? undefined : this.byId.get(idLista);
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
        // aperture-rvhlt: a convidado belongs to exactly one lista — linear
        // scan mirrors the postgres convidados.lista_id FK resolution.
        let encontrada: ListaDeConvidados | undefined;
        for (const lista of this.byId.values()) {
          if (lista.convidados.some((c) => c.id === idConvidado)) {
            encontrada = lista;
            break;
          }
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return encontrada;
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
          const existing = this.byId.get(id);
          if (!existing) {
            span.setStatus({ code: SpanStatusCode.OK });
            return undefined;
          }

          const updated = listaDeConvidadosComPresencaAlterada(
            existing,
            idConvidado,
            presenca,
            atualizadoEm,
          );
          this.byId.set(updated.id, updated);
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
        const existing = this.byId.get(id);
        if (existing) {
          this.byId.delete(id);
          if (this.eventoToListaId.get(existing.idEvento) === id) {
            this.eventoToListaId.delete(existing.idEvento);
          }
        }
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
