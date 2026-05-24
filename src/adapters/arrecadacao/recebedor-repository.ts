import type { Recebedor } from '../../domain/arrecadacao/entities/recebedor.js';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

/**
 * Persistência de recebedores (porta).
 */
export interface RecebedorRepository {
  save(recebedor: Recebedor, context?: ArrecadacaoRepositoryContext): Promise<void>;
  findAtivoByCampanhaId(
    idCampanha: IdCampanha,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<Recebedor | undefined>;
  findByCampanhaId(
    idCampanha: IdCampanha,
    context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Recebedor[]>;
}
