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
  /**
   * aperture-riywh. Admin-facing paginated browse across ALL campanhas.
   * Filters by `statusFilter` (solicitado | aprovado | all); the default
   * filter used by the admin UI is 'solicitado' (the action queue).
   * Cursor is opaque (the postgres adapter encodes (solicitadoEm, id)
   * for stable desc sort; memory adapter encodes the same shape).
   *
   * Returns:
   *   - repasses: page of RepasseRecebedor (sorted by solicitadoEm DESC).
   *   - nextCursor: opaque pagination cursor; null when no more pages.
   *   - totalCount: total matching rows (NOT page size). Lets the UI
   *     render "N solicitações pendentes" even before pagination ends.
   */
  findRepassesPaginated(input: {
    readonly statusFilter: 'solicitado' | 'aprovado' | 'all';
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<{
    readonly repasses: readonly RepasseRecebedor[];
    readonly nextCursor: string | null;
    readonly totalCount: number;
  }>;
  /**
   * aperture-riywh. Returns lançamentos linked to a single repasse
   * (`id_repasse = X`), in `criadoEm ASC` order. Used by the admin
   * drill-down to render the breakdown of which contributions a repasse
   * will pay out. Empty array if the repasse has no linked lançamentos
   * (shouldn't happen post-solicitação, but defensive).
   */
  findLancamentosByIdRepasse(idRepasse: IdRepasse): Promise<readonly LancamentoFinanceiro[]>;
  /**
   * aperture-s03dr. Returns the set of lançamentos currently eligible
   * for inclusion in a new repasse for `idCampanha`. Eligibility is the
   * full derived-liberação predicate:
   *
   *   tipo = 'credito_saldo_recebedor'
   *   id_campanha = X
   *   transferido_em IS NULL
   *   cancelado_em IS NULL
   *   id_repasse IS NULL                            (not yet swept)
   *   parent pagamento.status = 'aprovado'          (mjgxe derived predicate)
   *   parent pagamento.intencao_balance_transaction_available_on <= now
   *
   * Read-only — does NOT lock rows. The solicitação use-case calls this
   * for the preflight saldo check; the actual atomic sweep happens
   * inside `solicitarRepasseTransaction` (which re-runs the same
   * predicate under SELECT FOR UPDATE).
   *
   * Returns an empty array when no lançamentos are eligible.
   */
  findLancamentosDisponiveisByIdCampanha(
    idCampanha: IdCampanha,
    now: Date,
  ): Promise<readonly LancamentoFinanceiro[]>;
  /**
   * aperture-s03dr. Atomic solicitação of a repasse:
   *
   *   1. SELECT FOR UPDATE on the eligible lançamento set (same
   *      predicate as `findLancamentosDisponiveisByIdCampanha`).
   *   2. Compute amountCents = SUM(amount_cents) over the locked set.
   *   3. Build the `RepasseRecebedor` (factory in the use-case layer).
   *   4. INSERT the repasse + UPDATE lançamentos SET id_repasse = repasse.id
   *      WHERE id IN (locked set).
   *
   * Concurrency invariant: at most ONE pending repasse per campanha.
   * Enforced at two layers:
   *   - postgres: unique partial index
   *     `repasses_um_solicitado_por_campanha ON (id_campanha) WHERE status='solicitado'`.
   *     A concurrent INSERT racing past the row lock surfaces 23505;
   *     the adapter translates to `FinanceiroRepasseJaPendenteError`.
   *   - memory: preflight scan over the in-memory map.
   *
   * Throws:
   *   - `FinanceiroSaldoDisponivelInsuficienteError` when the locked set
   *     is empty (caller decides; use-case currently throws on empty).
   *   - `FinanceiroRepasseJaPendenteError` on the unique-index violation.
   *
   * Returns the persisted `RepasseRecebedor` (with the snapshotted
   * `amountCents` and `solicitadoEm`).
   */
  solicitarRepasseTransaction(input: {
    readonly idCampanha: IdCampanha;
    readonly idRepasse: IdRepasse;
    readonly solicitadoEm: Date;
    readonly now: Date;
  }): Promise<{
    readonly repasse: RepasseRecebedor;
    readonly idsLancamentosClaimados: readonly IdLancamentoFinanceiro[];
  }>;
  /**
   * aperture-s03dr. Atomic admin approval of a pending repasse:
   *
   *   1. SELECT FOR UPDATE on the target repasse.
   *   2. Verify status = 'solicitado' (throw FinanceiroRepasseStatusInvalidoError
   *      if not).
   *   3. UPDATE repasse SET status='aprovado', aprovado_em, bank_transfer_ref.
   *   4. UPDATE lançamentos SET transferido_em = aprovado_em
   *      WHERE id_repasse = repasse.id AND transferido_em IS NULL.
   *      (Cancelled lançamentos under the repasse are skipped — should
   *      never happen given the cascade-scope rule, but defensive.)
   *
   * Returns the updated repasse + count of lançamentos affected.
   *
   * Idempotency: if the repasse is ALREADY 'aprovado' with the same
   * bankTransferRef, the adapter no-ops and returns
   * `{ repasse: existing, lancamentosAfetados: 0 }`. The use-case layer
   * surfaces this as a 200 (caller treats as success). Mismatched
   * bankTransferRef on an already-aprovado repasse surfaces
   * `FinanceiroRepasseStatusInvalidoError` (don't silently overwrite
   * an audit value).
   *
   * Throws:
   *   - `FinanceiroRepasseNaoEncontradoError` when the repasse doesn't
   *     exist.
   *   - `FinanceiroRepasseStatusInvalidoError` when the repasse is in
   *     a non-solicitado state and the input would mutate the snapshot.
   */
  aprovarRepasseTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly aprovadoEm: Date;
    readonly bankTransferRef: string | null;
  }): Promise<{
    readonly repasse: RepasseRecebedor;
    readonly lancamentosAfetados: number;
  }>;
  findRecebedorAtivoPorIdCampanha(idCampanha: IdCampanha): Promise<DadosRecebedorAtivo | undefined>;
}
