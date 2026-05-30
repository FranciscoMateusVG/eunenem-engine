import type { Contribuicao } from '../../domain/arrecadacao/entities/contribuicao.js';
import type {
  IdCampanha,
  IdContribuicao,
  IdOpcaoContribuicao,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

/**
 * Persistência de Contribuições (porta). `save` faz upsert (insert ou update).
 */
export interface ContribuicaoRepository {
  save(contribuicao: Contribuicao): Promise<void>;
  /**
   * Persiste N contribuições em UMA única operação (aperture-d6atj fix-up).
   *
   * Semântica:
   *   - Atomic: all-or-nothing. Se uma linha falha (FK, unique, check),
   *     NENHUMA é persistida.
   *   - `saveBulk([single])` produz o mesmo estado de DB que `save(single)`
   *     — porém todas as N linhas viajam em um único round-trip.
   *   - Postgres adapter emite UM `INSERT INTO ... VALUES (...), (...), ...`
   *     (não N inserts). Memory adapter mantém o contrato via loop simples.
   *   - Array vazio: no-op (não emite INSERT, retorna ok).
   *   - NÃO faz upsert — o caller é responsável por garantir ids frescos
   *     (use-case `criarContribuicoesEmLote` minta UUID por item antes
   *     de chamar).
   */
  saveBulk(
    contribuicoes: readonly Contribuicao[],
    context?: ArrecadacaoRepositoryContext,
  ): Promise<void>;
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
