import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import type {
  IdCampanha,
  IdContribuicao,
  IdOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Persistência de Contribuições (porta). `save` faz upsert (insert ou update).
 */
export interface ContribuicaoRepository {
  save(contribuicao: Contribuicao): Promise<void>;
  findById(id: IdContribuicao): Promise<Contribuicao | undefined>;
  findByCampanhaId(idCampanha: IdCampanha): Promise<readonly Contribuicao[]>;
  /**
   * Conta quantas contribuições estão associadas a uma opção dentro de uma
   * campanha. Usado pelo `criarContribuicao` para enforce o cap
   * `LIMITE_CONTRIBUICOES_POR_OPCAO`. Adapter deve usar `SELECT COUNT(*)`
   * (não carregar a lista) — é uma query hot path.
   */
  countByOpcao(idCampanha: IdCampanha, idOpcao: IdOpcaoContribuicao): Promise<number>;
}
