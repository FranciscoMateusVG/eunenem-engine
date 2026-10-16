import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { down, up } from '../../migrations/20261016_057_campanha_membros_permissoes.js';

/**
 * aperture-1z18g — backfill rule from the operator: owner = the campaign's
 * creator; the creator is NOT recorded anywhere (no column on campanhas, no
 * timestamp/order on campanha_administradores), so EVERY current admin
 * becomes owner — nobody loses rights.
 */
const CAMP_SOLO = '10000000-0000-4000-8000-000000000001';
const CAMP_DUO = '10000000-0000-4000-8000-000000000002';
const CAMP_SEM_ADMIN = '10000000-0000-4000-8000-000000000003';
const A = '20000000-0000-4000-8000-00000000000a';
const B = '20000000-0000-4000-8000-00000000000b';
const C = '20000000-0000-4000-8000-00000000000c';

describe('057 campanha_membros_permissoes migration', () => {
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
      CREATE TABLE campanhas (id uuid PRIMARY KEY);
      CREATE TABLE campanha_administradores (
        campanha_id uuid NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
        id_usuario uuid NOT NULL,
        PRIMARY KEY (campanha_id, id_usuario)
      )
    `.execute(db);
    await sql`
      INSERT INTO campanhas (id) VALUES (${CAMP_SOLO}), (${CAMP_DUO}), (${CAMP_SEM_ADMIN})
    `.execute(db);
    await sql`
      INSERT INTO campanha_administradores (campanha_id, id_usuario)
      VALUES (${CAMP_SOLO}, ${A}), (${CAMP_DUO}, ${B}), (${CAMP_DUO}, ${C})
    `.execute(db);
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  async function papeis() {
    const { rows } = await sql<{
      campanha_id: string;
      id_conta: string;
      papel: string;
      permissoes: string[];
    }>`
      SELECT campanha_id, id_conta, papel, permissoes FROM campanha_membros_permissoes
      ORDER BY campanha_id, id_conta
    `.execute(db);
    return rows;
  }

  it('makes EVERY current admin an owner (creator not recorded) and leaves admin-less campaigns empty', async () => {
    await up(db);
    expect(await papeis()).toEqual([
      { campanha_id: CAMP_SOLO, id_conta: A, papel: 'owner', permissoes: [] },
      { campanha_id: CAMP_DUO, id_conta: B, papel: 'owner', permissoes: [] },
      { campanha_id: CAMP_DUO, id_conta: C, papel: 'owner', permissoes: [] },
    ]);
  });

  it('does NOT auto-grant anything to admins inserted after the migration (no trigger)', async () => {
    await up(db);
    await sql`INSERT INTO campanha_administradores VALUES (${CAMP_SEM_ADMIN}, ${A})`.execute(db);
    const rows = await papeis();
    expect(rows.some((r) => r.campanha_id === CAMP_SEM_ADMIN)).toBe(false);
  });

  it('rejects unknown papel and unknown / owner-only permissions at the DB level', async () => {
    await up(db);
    await expect(
      sql`INSERT INTO campanha_membros_permissoes (campanha_id, id_conta, papel) VALUES (${CAMP_SEM_ADMIN}, ${B}, 'admin')`.execute(
        db,
      ),
    ).rejects.toThrow(/papel_check/);
    await expect(
      sql`INSERT INTO campanha_membros_permissoes (campanha_id, id_conta, papel, permissoes)
          VALUES (${CAMP_SEM_ADMIN}, ${B}, 'membro', ARRAY['membros:gerenciar'])`.execute(db),
    ).rejects.toThrow(/permissoes_check/);
  });

  it('cascades with the campaign and rolls back cleanly', async () => {
    await up(db);
    await sql`DELETE FROM campanhas WHERE id = ${CAMP_SOLO}`.execute(db);
    expect((await papeis()).map((r) => r.id_conta)).toEqual([B, C]);
    await down(db);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'campanha_membros_permissoes'
    `.execute(db);
    expect(rows[0]?.n).toBe(0);
  });
});
