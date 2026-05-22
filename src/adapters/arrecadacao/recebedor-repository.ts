import type { IdCampanha } from '../../domain/arrecadacao/campanha.js';
import type { Recebedor } from '../../domain/arrecadacao/recebedor.js';
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
