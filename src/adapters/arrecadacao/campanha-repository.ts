import type { Campanha, IdCampanha } from '../../domain/arrecadacao/campanha.js';

/**
 * Persistência do agregado Campanha (porta).
 */
export interface CampanhaRepository {
  save(campanha: Campanha): Promise<void>;
  findById(id: IdCampanha): Promise<Campanha | undefined>;
}
