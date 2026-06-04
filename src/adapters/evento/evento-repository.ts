import type { Evento } from '../../domain/evento/entities/evento.js';
import type { IdCampanha, IdEvento } from '../../domain/evento/value-objects/ids.js';

/**
 * Persistência do agregado Evento (porta).
 * One event per campanha — enforced by concrete adapters.
 */
export interface EventoRepository {
  save(evento: Evento): Promise<void>;
  findById(id: IdEvento): Promise<Evento | undefined>;
  findByIdCampanha(idCampanha: IdCampanha): Promise<Evento | undefined>;
  /** Idempotent; useful for tests and future compensations. */
  delete(id: IdEvento): Promise<void>;
}
