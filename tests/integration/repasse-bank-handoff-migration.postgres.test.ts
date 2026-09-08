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
    ['amount', 1_999, RECEIPT, FINISHED],
    ['receipt', 2_000, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', FINISHED],
    ['finished timestamp', 2_000, RECEIPT, new Date('2026-09-08T12:12:09.140Z')],
  ] as const)('fails closed and rolls back when the target %s differs from the verified receipt', async (_predicate, amountCents, receipt, finishedAt) => {
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
    await sql`
      INSERT INTO lancamentos_financeiros (id, id_repasse, amount_cents, transferido_em)
      VALUES
        ('20000000-0000-4000-8000-000000000001', ${TARGET}::uuid, 1000, NULL),
        ('20000000-0000-4000-8000-000000000002', ${TARGET}::uuid, 1000, NULL)
    `.execute(db);

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
