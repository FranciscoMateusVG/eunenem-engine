import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { up } from '../../migrations/20260908_052_repasse_bank_handoff.js';

const TARGET = 'e2c18fc0-a5f9-4d23-a0e7-104b68327b57';
const RECEIPT = '5653aadc-4a37-c3ab-2998-c188115c2a29';
const FINISHED = new Date('2026-09-08T06:00:40.466Z');

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
        (id, status, inter_codigo_solicitacao, last_transfer_error, needs_manual_resolution)
      VALUES (${TARGET}::uuid, 'verificando', ${RECEIPT}, 'legacy', true)
    `.execute(db);
    await sql`
      INSERT INTO repasse_transfer_attempts
        (id, repasse_id, attempt_no, finished_at, http_status, outcome,
         codigo_solicitacao, state_before, state_after)
      VALUES
        ('10000000-0000-4000-8000-000000000001', ${TARGET}::uuid, 1,
         '2026-09-08T05:00:00Z', 400, 'falhou', NULL, 'transferindo', 'falhou'),
        ('10000000-0000-4000-8000-000000000004', ${TARGET}::uuid, 4,
         ${FINISHED}, 200, 'agendado_aprovacao', ${RECEIPT}, 'transferindo', 'verificando')
    `.execute(db);
    await sql`
      INSERT INTO lancamentos_financeiros (id, id_repasse, transferido_em)
      VALUES ('20000000-0000-4000-8000-000000000001', ${TARGET}::uuid, NULL)
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

  it('fails closed and rolls back when the target exists but the accepted-attempt predicates differ', async () => {
    await sql`
      INSERT INTO repasses_recebedor (id, status, inter_codigo_solicitacao)
      VALUES (${TARGET}::uuid, 'verificando', ${RECEIPT})
    `.execute(db);
    await sql`
      INSERT INTO repasse_transfer_attempts
        (id, repasse_id, attempt_no, finished_at, http_status, outcome, codigo_solicitacao)
      VALUES ('10000000-0000-4000-8000-000000000004', ${TARGET}::uuid, 4,
              ${FINISHED}, 400, 'falhou', ${RECEIPT})
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
});
