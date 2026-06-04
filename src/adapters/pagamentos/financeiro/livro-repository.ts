import type { IdCampanha } from '../../../domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../../domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type { DadosRecebedorAtivo } from '../../../domain/pagamentos/financeiro/value-objects/dados-recebedor-ativo.js';
import type {
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
} from '../../../domain/pagamentos/financeiro/value-objects/ids.js';

/**
 * Persistência do livro financeiro (porta).
 *
 * **Plan 0015 (aperture-ucgok).** The FSM-based methods are gone with
 * the lançamento FSM:
 *   - `findPendentesMaturos` + `marcarComoDisponivel` REMOVED
 *     (predicted-maturation use-case `maturar-lancamentos-pendentes`
 *     deleted in Phase 1).
 *
 * Replaced by observed-event methods:
 *   - `marcarLancamentosComoTransferidos` — admin batch action that
 *     stamps `transferidoEm` on a set of lançamento IDs (idempotent
 *     at the row level — rows already transferred are silently
 *     skipped by the WHERE clause).
 *   - `marcarLancamentosComoCanceladosPorPagamento` — estorno cascade
 *     that stamps `canceladoEm` on the not-yet-transferred subset of
 *     a pagamento's lançamentos.
 *   - `hasLancamentosTransferidos` — boolean predicate used by the
 *     `estornar-pagamento` use-case's 409 gate.
 */
export interface LivroFinanceiroRepository {
  saveLancamentos(lancamentos: readonly LancamentoFinanceiro[]): Promise<void>;
  findLancamentosByIdPagamento(
    idPagamento: IdPagamentoReferencia,
  ): Promise<readonly LancamentoFinanceiro[]>;
  /**
   * Plan 0015 / aperture-mjgxe. Bulk-lookup by id — used by the
   * `marcarLancamentoTransferido` use-case's gate to resolve which
   * pagamento each input lançamento belongs to before checking the
   * derived liberação predicate. Returns only matched rows;
   * caller-side responsibility to detect missing ids.
   */
  findLancamentosByIds(
    ids: readonly IdLancamentoFinanceiro[],
  ): Promise<readonly LancamentoFinanceiro[]>;
  findLancamentosByIdCampanha(idCampanha: IdCampanha): Promise<readonly LancamentoFinanceiro[]>;
  findLancamentosReceitaPlataforma(): Promise<readonly LancamentoFinanceiro[]>;
  /**
   * Plan 0015. Idempotent batch flip: stamps `transferidoEm` on every
   * row whose id is in the input set AND that does NOT already have a
   * `transferidoEm` value AND that does NOT have a `canceladoEm` value
   * (cancelled rows can't be transferred). Rows that fail the WHERE
   * are silently skipped — re-marking is a no-op. The admin can pass
   * a mix of fresh + already-marked ids without error.
   */
  marcarLancamentosComoTransferidos(
    idsLancamentos: readonly IdLancamentoFinanceiro[],
    transferidoEm: Date,
  ): Promise<void>;
  /**
   * Plan 0015. Estorno cascade: stamps `canceladoEm` on every
   * lançamento for the given pagamento that has NOT been transferred
   * yet (`transferidoEm IS NULL`). Already-transferred rows are
   * intentionally NOT touched — the upstream `estornar-pagamento`
   * use-case enforces the pre-transfer 409 gate, so any
   * already-transferred row reaching this method would be a bug.
   * Idempotent at the row level: a row that already has
   * `canceladoEm` set is silently skipped.
   */
  marcarLancamentosComoCanceladosPorPagamento(
    idPagamento: IdPagamentoReferencia,
    canceladoEm: Date,
  ): Promise<void>;
  /**
   * Plan 0015. Returns true if the pagamento has at least one
   * lançamento with `transferidoEm IS NOT NULL`. Used by the
   * `estornar-pagamento` 409 gate — once any row has been
   * transferred to the recebedor, the refund path through THIS
   * endpoint is closed (the operator would need to handle a
   * disputes / chargeback flow instead, which is out of scope for
   * plan 0015).
   */
  hasLancamentosTransferidos(idPagamento: IdPagamentoReferencia): Promise<boolean>;
  saveRepasse(repasse: RepasseRecebedor): Promise<void>;
  findRepasseById(idRepasse: IdRepasse): Promise<RepasseRecebedor | undefined>;
  findRepassesByIdCampanha(idCampanha: IdCampanha): Promise<readonly RepasseRecebedor[]>;
  findRecebedorAtivoPorIdCampanha(idCampanha: IdCampanha): Promise<DadosRecebedorAtivo | undefined>;
}
