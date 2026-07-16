import { SpanStatusCode, trace } from '@opentelemetry/api';
import { type Kysely, sql } from 'kysely';
import type { Db, PgBoss } from 'pg-boss';
import type { Database } from '../../../../src/adapters/database.js';
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
 * Explicit retry policy for the executar queue. pg-boss v12 defaults
 * retryLimit to 2 — BELOW the executar handler's in-process transient cap
 * (MAX_TENTATIVAS_TRANSITORIAS = 4). If pg-boss gives up after 2 retries, a
 * persistently-transient failure strands the repasse in `aprovado` (the last
 * transitorio revert) with a dead job and NO sweeper. This limit MUST stay
 * strictly greater than that cap so the handler's own falhou terminator fires
 * first; the +buffer covers the initial delivery. `retryBackoff` spaces the
 * transient retries (15s, 30s, 60s…). `expireInSeconds` bounds a hung handler
 * (a stalled Inter HTTP call) — re-delivery is money-safe because iniciar's
 * FOR-UPDATE `reconciliar` branch diverts a re-delivered in-flight attempt to
 * verificando instead of re-calling pagarPix.
 */
const EXECUTAR_JOB_OPTIONS = {
  retryLimit: 6, // > MAX_TENTATIVAS_TRANSITORIAS (4) — handler terminates first
  retryDelay: 15,
  retryBackoff: true,
  expireInSeconds: 120,
} as const;

/**
 * Retry policy for the confirmar queue. Confirmar self-reschedules on its own
 * escalating backoff (via enqueueConfirmar), so pg-boss retries only cover
 * transient handler faults (e.g. a provider blip). It NEVER moves money, so a
 * few quick retries are safe. `expireInSeconds` bounds a hung poll.
 */
const CONFIRMAR_JOB_OPTIONS = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 60,
} as const;

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
  /**
   * `db` shares the same Kysely instance / pool as the domain repos — used only
   * to introspect the pg-boss job table for {@link hasPendingConfirmar}.
   */
  constructor(
    private readonly boss: PgBoss,
    private readonly db: Database,
  ) {}

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
          // Explicit retry policy either way (see EXECUTAR_JOB_OPTIONS).
          await this.boss.send(
            REPASSE_EXECUTAR_QUEUE,
            data,
            executor
              ? { ...EXECUTAR_JOB_OPTIONS, db: toPgBossDb(executor) }
              : { ...EXECUTAR_JOB_OPTIONS },
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
            ...CONFIRMAR_JOB_OPTIONS,
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

  /**
   * aperture-taacl — true iff a NOT-yet-terminal confirmar job exists for this
   * repasse. pg-boss v12 job states: created / retry / active are pending (job
   * will still run or is running); completed / cancelled / failed are terminal.
   * The sweeper re-enqueues confirmar only when this is false (the enqueue was
   * lost) — a healthy repasse mid-escalation always has a `created` job with a
   * future `start_after`.
   */
  hasPendingConfirmar(idRepasse: string): Promise<boolean> {
    return tracer.startActiveSpan('repasse.has_pending_confirmar', async (span) => {
      span.setAttribute('repasse.id', idRepasse);
      try {
        // `this.db` is the engine's Kysely (root package); `sql` here resolves
        // to the app package's Kysely. They differ only at the patch level and
        // are runtime-compatible, but the dual-package types don't unify — cast
        // at this single execute boundary (same pattern as the postgres repos'
        // `this.db as any` raw ops).
        const result = await sql<{ exists: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM pgboss.job
            WHERE name = ${REPASSE_CONFIRMAR_QUEUE}
              AND data->>'idRepasse' = ${idRepasse}
              AND state IN ('created', 'retry', 'active')
          ) AS exists
        `.execute(this.db as unknown as Kysely<unknown>);
        const pending = result.rows[0]?.exists ?? false;
        span.setAttribute('repasse.has_pending_confirmar', pending);
        span.setStatus({ code: SpanStatusCode.OK });
        return pending;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : 'query failed',
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
