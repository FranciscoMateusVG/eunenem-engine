import type { Contribuicao, IdContribuicao } from '../../domain/arrecadacao/contribuicao.js';

/**
 * Persistência de Contribuições (porta). `save` faz upsert (insert ou update).
 */
export interface ContribuicaoRepository {
  save(contribuicao: Contribuicao): Promise<void>;
  findById(id: IdContribuicao): Promise<Contribuicao | undefined>;
}
