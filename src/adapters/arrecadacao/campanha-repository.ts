import type { Campanha } from '../../domain/arrecadacao/entities/campanha.js';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

/**
 * Persistência do agregado Campanha (porta).
 */
export interface CampanhaRepository {
  save(campanha: Campanha, context?: ArrecadacaoRepositoryContext): Promise<void>;
  findById(id: IdCampanha, context?: ArrecadacaoRepositoryContext): Promise<Campanha | undefined>;
}
