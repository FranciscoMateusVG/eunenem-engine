import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import type { IdContribuicao } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Persistência de Contribuições (porta). `save` faz upsert (insert ou update).
 */
export interface ContribuicaoRepository {
  save(contribuicao: Contribuicao): Promise<void>;
  findById(id: IdContribuicao): Promise<Contribuicao | undefined>;
}
