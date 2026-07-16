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
}

export const REPASSE_EXECUTAR_QUEUE = 'repasse.executar';
export const REPASSE_CONFIRMAR_QUEUE = 'repasse.confirmar';
