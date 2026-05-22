import type { Campanha, IdCampanha } from '../../domain/arrecadacao/campanha.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

/**
 * Persistência do agregado Campanha (porta).
 */
export interface CampanhaRepository {
  save(campanha: Campanha, context?: ArrecadacaoRepositoryContext): Promise<void>;
  findById(id: IdCampanha, context?: ArrecadacaoRepositoryContext): Promise<Campanha | undefined>;
}
