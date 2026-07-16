import type { RepasseTransactionExecutor } from './financeiro/livro-repository.js';

export interface RepasseExecutarJobData {
  readonly idRepasse: string;
}
export interface RepasseConfirmarJobData {
  readonly idRepasse: string;
  readonly tentativaConfirmacao: number;
}

export interface RepasseJobEnqueuer {
  /**
   * Enqueue the executar job. When `executor` is supplied the insert rides
   * that transaction (the approve = pay path — atomic with the FSM write).
   * When omitted it is a plain enqueue on pg-boss's own pool (the admin
   * retry path, which has no surrounding transaction).
   */
  enqueueExecutar(
    data: RepasseExecutarJobData,
    executor?: RepasseTransactionExecutor,
  ): Promise<void>;
  /** Scheduled enqueue of the confirm/reconcile poll, delayed by `delaySeconds`. */
  enqueueConfirmar(data: RepasseConfirmarJobData, delaySeconds: number): Promise<void>;
  /**
   * aperture-taacl — does a NOT-yet-terminal confirmar job exist for this
   * repasse (created / active / retry)? Used by the orphaned-verificando
   * sweeper to distinguish a repasse whose confirmar enqueue was LOST (crash
   * between the verificando commit and the non-atomic enqueue) from a healthy
   * one still waiting on a scheduled poll. Job-queue state is the enqueuer's
   * concern, so this check lives here (not on the livro repository).
   */
  hasPendingConfirmar(idRepasse: string): Promise<boolean>;
}

export const REPASSE_EXECUTAR_QUEUE = 'repasse.executar';
export const REPASSE_CONFIRMAR_QUEUE = 'repasse.confirmar';
/**
 * aperture-taacl — the periodic orphaned-verificando sweep queue. A pg-boss
 * cron schedule lands one job here per interval; its worker runs
 * varrerRepassesVerificandoOrfaos to re-arm repasses whose confirmar enqueue
 * was lost.
 */
export const REPASSE_SWEEP_VERIFICANDO_QUEUE = 'repasse.sweep_verificando';
