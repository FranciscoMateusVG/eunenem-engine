import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { down, up } from '../../migrations/20260908_052_repasse_bank_handoff.js';

const TARGET = 'e2c18fc0-a5f9-4d23-a0e7-104b68327b57';
const RECEIPT = '203f4559-72d8-4675-9f79-aa360b9f4456';
const FINISHED = new Date('2026-09-08T12:12:09.139Z');

describe('052 guarded operator-authorized payout handoff migration', () => {
  let container: StartedPostgreSqlContainer;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('frame')
      .withUsername('frame')
      .withPassword('frame')
      .start();
    db = new Kysely({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: container.getConnectionUri() }),
      }),
    });
  }, 60_000);

  beforeEach(async () => {
    await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public`.execute(db);
    await sql`
      CREATE TABLE repasses_recebedor (
        id uuid PRIMARY KEY,
        amount_cents integer NOT NULL,
        status text NOT NULL,
        inter_codigo_solicitacao text,
        last_transfer_error text,
        needs_manual_resolution boolean NOT NULL DEFAULT false,
        CONSTRAINT repasses_recebedor_status_check CHECK (
          status IN ('solicitado','aprovado','transferindo','verificando','pago','falhou','cancelado')
        )
      );
      CREATE TABLE repasse_transfer_attempts (
        id uuid PRIMARY KEY,
        repasse_id uuid NOT NULL,
        attempt_no integer NOT NULL,
        finished_at timestamptz,
        http_status smallint,
        outcome text,
        codigo_solicitacao text,
        state_before text,
        state_after text,
        CONSTRAINT repasse_attempt_state_before_check CHECK (
          state_before IS NULL OR state_before IN ('solicitado','aprovado','transferindo','verificando','pago','falhou','cancelado')
        ),
        CONSTRAINT repasse_attempt_state_after_check CHECK (
          state_after IS NULL OR state_after IN ('solicitado','aprovado','transferindo','verificando','pago','falhou','cancelado')
        )
      );
      CREATE TABLE lancamentos_financeiros (
        id uuid PRIMARY KEY,
        id_repasse uuid,
        amount_cents integer NOT NULL,
        transferido_em timestamptz
      )
    `.execute(db);
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it('converts only the exact accepted attempt 4 and preserves receipt, timestamp, history and unsettled ledger', async () => {
    await sql`
      INSERT INTO repasses_recebedor
        (id, amount_cents, status, inter_codigo_solicitacao,
         last_transfer_error, needs_manual_resolution)
      VALUES (${TARGET}::uuid, 2000, 'verificando', ${RECEIPT}, 'legacy', true)
    `.execute(db);
    await sql`
      INSERT INTO repasse_transfer_attempts
        (id, repasse_id, attempt_no, finished_at, http_status, outcome,
         codigo_solicitacao, state_before, state_after)
      VALUES
        ('10000000-0000-4000-8000-000000000001', ${TARGET}::uuid, 1,
         '2026-09-08T05:00:00Z', 400, 'falhou', NULL, 'transferindo', 'falhou'),
        ('10000000-0000-4000-8000-000000000004', ${TARGET}::uuid, 4,
         ${FINISHED}, 200, 'verificando', ${RECEIPT}, 'transferindo', 'verificando')
    `.execute(db);
    await sql`
      INSERT INTO lancamentos_financeiros (id, id_repasse, amount_cents, transferido_em)
      VALUES
        ('20000000-0000-4000-8000-000000000001', ${TARGET}::uuid, 1000, NULL),
        ('20000000-0000-4000-8000-000000000002', ${TARGET}::uuid, 1000, NULL)
    `.execute(db);

    await db.transaction().execute((trx) => up(trx));

    const repasse = await sql<{
      status: string;
      enviado_ao_banco_em: Date | null;
      inter_codigo_solicitacao: string | null;
      last_transfer_error: string | null;
      needs_manual_resolution: boolean;
    }>`SELECT status, enviado_ao_banco_em, inter_codigo_solicitacao,
              last_transfer_error, needs_manual_resolution
         FROM repasses_recebedor WHERE id = ${TARGET}::uuid`.execute(db);
    expect(repasse.rows[0]).toEqual({
      status: 'enviado_ao_banco',
      enviado_ao_banco_em: FINISHED,
      inter_codigo_solicitacao: RECEIPT,
      last_transfer_error: null,
      needs_manual_resolution: false,
    });
    expect(
      (await sql<{ count: string }>`SELECT count(*) FROM repasse_transfer_attempts`.execute(db))
        .rows[0]?.count,
    ).toBe('2');
    expect(
      (
        await sql<{
          transferido_em: Date | null;
        }>`SELECT transferido_em FROM lancamentos_financeiros`.execute(db)
      ).rows[0]?.transferido_em,
    ).toBeNull();
  });

  it.each([
    ['amount', 1_999, RECEIPT, FINISHED, 'exact'],
    ['receipt', 2_000, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', FINISHED, 'exact'],
    ['finished timestamp', 2_000, RECEIPT, new Date('2026-09-08T12:12:09.140Z'), 'exact'],
    ['linked-ledger row count', 2_000, RECEIPT, FINISHED, 'one-row'],
    ['linked-ledger amount sum', 2_000, RECEIPT, FINISHED, 'wrong-total'],
    ['linked-ledger settlement', 2_000, RECEIPT, FINISHED, 'settled'],
  ] as const)('fails closed and rolls back when the target %s differs from the verified receipt', async (_predicate, amountCents, receipt, finishedAt, ledgerVariant) => {
    await sql`
      INSERT INTO repasses_recebedor (id, amount_cents, status, inter_codigo_solicitacao)
      VALUES (${TARGET}::uuid, ${amountCents}, 'verificando', ${receipt})
    `.execute(db);
    await sql`
      INSERT INTO repasse_transfer_attempts
        (id, repasse_id, attempt_no, finished_at, http_status, outcome, codigo_solicitacao)
      VALUES ('10000000-0000-4000-8000-000000000004', ${TARGET}::uuid, 4,
              ${finishedAt}, 200, 'verificando', ${receipt})
    `.execute(db);
    const firstAmount = ledgerVariant === 'one-row' ? 2_000 : 1_000;
    const firstTransferredAt = ledgerVariant === 'settled' ? FINISHED : null;
    await sql`
      INSERT INTO lancamentos_financeiros (id, id_repasse, amount_cents, transferido_em)
      VALUES ('20000000-0000-4000-8000-000000000001', ${TARGET}::uuid,
              ${firstAmount}, ${firstTransferredAt})
    `.execute(db);
    if (ledgerVariant !== 'one-row') {
      const secondAmount = ledgerVariant === 'wrong-total' ? 999 : 1_000;
      await sql`
        INSERT INTO lancamentos_financeiros (id, id_repasse, amount_cents, transferido_em)
        VALUES ('20000000-0000-4000-8000-000000000002', ${TARGET}::uuid,
                ${secondAmount}, NULL)
      `.execute(db);
    }

    await expect(db.transaction().execute((trx) => up(trx))).rejects.toThrow(
      'operator-authorized payout handoff target does not match guarded predicates',
    );

    expect(
      (
        await sql<{
          status: string;
        }>`SELECT status FROM repasses_recebedor WHERE id = ${TARGET}::uuid`.execute(db)
      ).rows[0]?.status,
    ).toBe('verificando');
  });

  it('fails closed when the exact guarded mutation does not update one target row', async () => {
    await sql`
      INSERT INTO repasses_recebedor
        (id, amount_cents, status, inter_codigo_solicitacao)
      VALUES (${TARGET}::uuid, 2000, 'verificando', ${RECEIPT})
    `.execute(db);
    await sql`
      INSERT INTO repasse_transfer_attempts
        (id, repasse_id, attempt_no, finished_at, http_status, outcome, codigo_solicitacao)
      VALUES ('10000000-0000-4000-8000-000000000004', ${TARGET}::uuid, 4,
              ${FINISHED}, 200, 'verificando', ${RECEIPT})
    `.execute(db);
    await sql`
      INSERT INTO lancamentos_financeiros (id, id_repasse, amount_cents, transferido_em)
      VALUES
        ('20000000-0000-4000-8000-000000000001', ${TARGET}::uuid, 1000, NULL),
        ('20000000-0000-4000-8000-000000000002', ${TARGET}::uuid, 1000, NULL)
    `.execute(db);
    await sql`
      CREATE FUNCTION suppress_bank_handoff() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.status = 'enviado_ao_banco' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END
      $fn$
    `.execute(db);
    await sql`
      CREATE TRIGGER suppress_bank_handoff
        BEFORE UPDATE ON repasses_recebedor
        FOR EACH ROW EXECUTE FUNCTION suppress_bank_handoff()
    `.execute(db);

    await expect(db.transaction().execute((trx) => up(trx))).rejects.toThrow(
      'operator-authorized payout handoff target does not match guarded predicates',
    );
    expect(
      (
        await sql<{ status: string }>`
          SELECT status FROM repasses_recebedor WHERE id = ${TARGET}::uuid
        `.execute(db)
      ).rows[0]?.status,
    ).toBe('verificando');
  });

  it('waits for concurrent ledger drift and then rejects conversion against the committed state', async () => {
    await sql`
      INSERT INTO repasses_recebedor
        (id, amount_cents, status, inter_codigo_solicitacao)
      VALUES (${TARGET}::uuid, 2000, 'verificando', ${RECEIPT})
    `.execute(db);
    await sql`
      INSERT INTO repasse_transfer_attempts
        (id, repasse_id, attempt_no, finished_at, http_status, outcome, codigo_solicitacao)
      VALUES ('10000000-0000-4000-8000-000000000004', ${TARGET}::uuid, 4,
              ${FINISHED}, 200, 'verificando', ${RECEIPT})
    `.execute(db);
    await sql`
      INSERT INTO lancamentos_financeiros (id, id_repasse, amount_cents, transferido_em)
      VALUES
        ('20000000-0000-4000-8000-000000000001', ${TARGET}::uuid, 1000, NULL),
        ('20000000-0000-4000-8000-000000000002', ${TARGET}::uuid, 1000, NULL)
    `.execute(db);

    let signalDriftReady: (() => void) | undefined;
    let releaseDrift: (() => void) | undefined;
    const driftReady = new Promise<void>((resolve) => {
      signalDriftReady = resolve;
    });
    const driftMayCommit = new Promise<void>((resolve) => {
      releaseDrift = resolve;
    });
    const drift = db.transaction().execute(async (trx) => {
      await sql`
        UPDATE lancamentos_financeiros
          SET transferido_em = ${FINISHED}
          WHERE id = '20000000-0000-4000-8000-000000000001'::uuid
      `.execute(trx);
      signalDriftReady?.();
      await driftMayCommit;
    });
    await driftReady;

    let signalMigrationPid: ((pid: number) => void) | undefined;
    const migrationPidReady = new Promise<number>((resolve) => {
      signalMigrationPid = resolve;
    });
    const migration = db
      .transaction()
      .execute(async (trx) => {
        const pid = await sql<{ pid: number }>`
          SELECT pg_backend_pid()::integer AS pid
        `.execute(trx);
        signalMigrationPid?.(pid.rows[0]?.pid as number);
        await up(trx);
      })
      .then(
        () => ({ succeeded: true as const, error: undefined }),
        (error: unknown) => ({ succeeded: false as const, error }),
      );
    const migrationPid = await migrationPidReady;
    let result: Awaited<typeof migration> | undefined;
    try {
      await expect
        .poll(
          async () => {
            const waiting = await sql<{ waiting: boolean }>`
              SELECT EXISTS (
                SELECT 1
                  FROM pg_locks held
                  JOIN pg_class relation ON relation.oid = held.relation
                  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                  WHERE held.pid = ${migrationPid}
                    AND held.mode = 'ShareLock'
                    AND held.granted = FALSE
                    AND namespace.nspname = 'public'
                    AND relation.relname = 'lancamentos_financeiros'
              ) AS waiting
            `.execute(db);
            return waiting.rows[0]?.waiting;
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
    } finally {
      releaseDrift?.();
      await drift;
      result = await migration;
    }

    expect(result).toBeDefined();
    if (result === undefined) throw new Error('migration result unavailable');
    expect(result.succeeded).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain(
      'operator-authorized payout handoff target does not match guarded predicates',
    );
    expect(
      (
        await sql<{ status: string }>`
          SELECT status FROM repasses_recebedor WHERE id = ${TARGET}::uuid
        `.execute(db)
      ).rows[0]?.status,
    ).toBe('verificando');
  });

  it('maps accepted state snapshots on down so old checks can be restored without losing the attempt', async () => {
    await db.transaction().execute((trx) => up(trx));
    const repasseId = '30000000-0000-4000-8000-000000000001';
    const attemptId = '30000000-0000-4000-8000-000000000002';
    await sql`
      INSERT INTO repasses_recebedor
        (id, amount_cents, status, enviado_ao_banco_em, inter_codigo_solicitacao)
      VALUES (${repasseId}::uuid, 2000, 'enviado_ao_banco', ${FINISHED}, ${RECEIPT})
    `.execute(db);
    await sql`
      INSERT INTO repasse_transfer_attempts
        (id, repasse_id, attempt_no, finished_at, http_status, outcome,
         codigo_solicitacao, state_before, state_after)
      VALUES (${attemptId}::uuid, ${repasseId}::uuid, 1, ${FINISHED}, 200,
              'aceito_pelo_banco', ${RECEIPT}, 'enviado_ao_banco', 'enviado_ao_banco')
    `.execute(db);

    await db.transaction().execute((trx) => down(trx));

    const repasse = await sql<{ status: string; inter_codigo_solicitacao: string | null }>`
      SELECT status, inter_codigo_solicitacao
        FROM repasses_recebedor
        WHERE id = ${repasseId}::uuid
    `.execute(db);
    expect(repasse.rows[0]).toEqual({
      status: 'verificando',
      inter_codigo_solicitacao: RECEIPT,
    });
    const attempt = await sql<{
      state_before: string | null;
      state_after: string | null;
      outcome: string | null;
      codigo_solicitacao: string | null;
    }>`
      SELECT state_before, state_after, outcome, codigo_solicitacao
        FROM repasse_transfer_attempts
        WHERE id = ${attemptId}::uuid
    `.execute(db);
    expect(attempt.rows[0]).toEqual({
      state_before: 'verificando',
      state_after: 'verificando',
      outcome: 'aceito_pelo_banco',
      codigo_solicitacao: RECEIPT,
    });
  });
});
