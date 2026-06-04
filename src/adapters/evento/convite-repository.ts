import type { Convite } from '../../domain/evento/entities/convite.js';
import type { IdConvite, IdEvento } from '../../domain/evento/value-objects/ids.js';

/**
 * Persistência do agregado Convite (porta).
 * One invite per event — enforced by concrete adapters.
 */
export interface ConviteRepository {
  save(convite: Convite): Promise<void>;
  findById(id: IdConvite): Promise<Convite | undefined>;
  findByIdEvento(idEvento: IdEvento): Promise<Convite | undefined>;
  /** Idempotent; useful for tests and future compensations. */
  delete(id: IdConvite): Promise<void>;
}
