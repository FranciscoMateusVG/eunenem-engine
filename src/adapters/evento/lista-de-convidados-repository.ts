import type { ListaDeConvidados } from '../../domain/evento/entities/lista-de-convidados.js';
import type {
  IdConvidado,
  IdEvento,
  IdListaDeConvidados,
} from '../../domain/evento/value-objects/ids.js';
import type { StatusPresencaConvidado } from '../../domain/evento/value-objects/status-presenca-convidado.js';

/**
 * Persistência do agregado ListaDeConvidados (porta).
 * One guest list per event — enforced by concrete adapters.
 */
export interface ListaDeConvidadosRepository {
  save(listaDeConvidados: ListaDeConvidados): Promise<void>;
  findById(id: IdListaDeConvidados): Promise<ListaDeConvidados | undefined>;
  findByIdEvento(idEvento: IdEvento): Promise<ListaDeConvidados | undefined>;
  alterarPresencaConvidado(
    id: IdListaDeConvidados,
    idConvidado: IdConvidado,
    presenca: StatusPresencaConvidado,
    atualizadoEm: Date,
  ): Promise<ListaDeConvidados | undefined>;
  /** Idempotent; useful for tests and future compensations. */
  delete(id: IdListaDeConvidados): Promise<void>;
}
