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
   * Lista as contribuições associadas a uma opção dentro de uma campanha
   * (aperture-d6atj). Usado pelo `listarContribuicoesDeOpcao` para alimentar
   * `contribuicao.list` no tRPC do eunenem-server. Não pagina — caller é
   * responsável por respeitar o `LIMITE_CONTRIBUICOES_POR_OPCAO`.
   */
  findByOpcao(
    idCampanha: IdCampanha,
    idOpcao: IdOpcaoContribuicao,
  ): Promise<readonly Contribuicao[]>;
  /**
   * Conta quantas contribuições estão associadas a uma opção dentro de uma
   * campanha. Usado pelo `criarContribuicao` para enforce o cap
   * `LIMITE_CONTRIBUICOES_POR_OPCAO`. Adapter deve usar `SELECT COUNT(*)`
   * (não carregar a lista) — é uma query hot path.
   */
  countByOpcao(idCampanha: IdCampanha, idOpcao: IdOpcaoContribuicao): Promise<number>;
  /**
   * Remove uma contribuição pelo id (aperture-d6atj). Caller (use-case
   * `removerContribuicao`) já validou status + autorização — o adapter só
   * executa o DELETE. Idempotente: deletar um id inexistente é no-op.
   */
  deleteById(id: IdContribuicao): Promise<void>;
}
