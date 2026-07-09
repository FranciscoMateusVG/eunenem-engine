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
  /**
   * aperture-rvhlt — convidado-first resolution for the public RSVP flow.
   * `idConvidado` uniquely determines its lista (convidados.lista_id FK; a
   * convidado belongs to exactly one lista), which via lista→evento→
   * UNIQUE(id_campanha) uniquely determines the campanha. Lets the RSVP hop
   * resolve the RIGHT campanha's lista instead of the slug-owner's oldest.
   */
  findByConvidadoId(idConvidado: IdConvidado): Promise<ListaDeConvidados | undefined>;
  alterarPresencaConvidado(
    id: IdListaDeConvidados,
    idConvidado: IdConvidado,
    presenca: StatusPresencaConvidado,
    atualizadoEm: Date,
  ): Promise<ListaDeConvidados | undefined>;
  /** Idempotent; useful for tests and future compensations. */
  delete(id: IdListaDeConvidados): Promise<void>;
}
