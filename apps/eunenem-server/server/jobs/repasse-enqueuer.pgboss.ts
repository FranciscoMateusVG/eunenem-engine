import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Db, PgBoss } from 'pg-boss';
import type { RepasseTransactionExecutor } from '../../../../src/adapters/pagamentos/financeiro/livro-repository.js';
import {
  REPASSE_CONFIRMAR_QUEUE,
  REPASSE_EXECUTAR_QUEUE,
  type RepasseConfirmarJobData,
  type RepasseExecutarJobData,
  type RepasseJobEnqueuer,
} from '../../../../src/adapters/pagamentos/transferencia-enqueuer.js';

const tracer = trace.getTracer('eunenem-server');

/**
 * Wraps the engine's transaction-bound {@link RepasseTransactionExecutor} into
 * the {@link Db} shape pg-boss expects for its `db` send option. pg-boss calls
 * `executeSql(text, values)` on this object, so the job INSERT rides the SAME
 * transaction as the FSM write. The engine executor returns a `readonly` row
 * array; the spread copies it into the mutable array pg-boss's `Db` declares.
 */
function toPgBossDb(executor: RepasseTransactionExecutor): Db {
  return {
    executeSql: (text, values) =>
      executor
        .executeSql(text, values ?? [])
        .then((result) => ({ rows: [...result.rows] })),
  };
}

/**
 * pg-boss-backed adapter for {@link RepasseJobEnqueuer}. Owns no lifecycle —
 * the shared `PgBoss` instance is started/stopped by the composition root.
 */
export class RepasseJobEnqueuerPgBoss implements RepasseJobEnqueuer {
  constructor(private readonly boss: PgBoss) {}

  /**
   * Transactional enqueue: the job INSERT rides `executor`'s transaction via
   * pg-boss's `db` send option, so the job is only durable if the FSM write
   * commits.
   */
  enqueueExecutar(
    data: RepasseExecutarJobData,
    executor?: RepasseTransactionExecutor,
  ): Promise<void> {
    return tracer.startActiveSpan(
      'repasse.enqueue.executar',
      async (span) => {
        span.setAttribute('repasse.id', data.idRepasse);
        span.setAttribute('messaging.destination.name', REPASSE_EXECUTAR_QUEUE);
        span.setAttribute('repasse.transacional', executor !== undefined);
        try {
          // Transactional (approve = pay) when an executor is supplied;
          // plain enqueue on pg-boss's own pool for the admin retry path.
          await this.boss.send(
            REPASSE_EXECUTAR_QUEUE,
            data,
            executor ? { db: toPgBossDb(executor) } : {},
          );
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : 'enqueue failed',
          });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Scheduled enqueue of the confirm/reconcile poll, delayed by `delaySeconds`.
   * A numeric `startAfter` is interpreted by pg-boss as a delay in seconds.
   */
  enqueueConfirmar(
    data: RepasseConfirmarJobData,
    delaySeconds: number,
  ): Promise<void> {
    return tracer.startActiveSpan(
      'repasse.enqueue.confirmar',
      async (span) => {
        span.setAttribute('repasse.id', data.idRepasse);
        span.setAttribute(
          'repasse.tentativa_confirmacao',
          data.tentativaConfirmacao,
        );
        span.setAttribute('messaging.destination.name', REPASSE_CONFIRMAR_QUEUE);
        span.setAttribute('repasse.delay_seconds', delaySeconds);
        try {
          await this.boss.send(REPASSE_CONFIRMAR_QUEUE, data, {
            startAfter: delaySeconds,
          });
        } catch (err) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : 'enqueue failed',
          });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }
}
