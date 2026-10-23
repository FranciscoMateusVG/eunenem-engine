import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { up as upCompartilhamento } from '../../migrations/20261016_058_campanha_compartilhamento.js';
import { down, up } from '../../migrations/20261016_059_campanha_convites_permissoes.js';
import { PERMISSOES_PADRAO_MEMBRO } from '../../src/domain/arrecadacao/value-objects/permissao-campanha.js';

/**
 * aperture-m3vx4 — invites carry the permission set chosen by the owner.
 * Invites created before this migration were sent under the old rule ("new
 * members get PERMISSOES_PADRAO_MEMBRO"), so every existing row is backfilled
 * with exactly that set: accepting an old pending invite grants what it always
 * would have.
 */
const CAMP = '10000000-0000-4000-8000-000000000001';
const ATOR = '20000000-0000-4000-8000-00000000000a';
const PENDENTE = '30000000-0000-4000-8000-000000000001';
const ACEITO = '30000000-0000-4000-8000-000000000002';

describe('059 campanha_convites.permissoes migration', () => {
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
    await sql`CREATE TABLE campanhas (id uuid PRIMARY KEY)`.execute(db);
    await sql`INSERT INTO campanhas (id) VALUES (${CAMP})`.execute(db);
    await upCompartilhamento(db);
    await sql`
      INSERT INTO campanha_convites (id, campanha_id, email, criado_por, expira_em)
      VALUES (${PENDENTE}, ${CAMP}, 'pendente@example.com', ${ATOR}, now() + interval '7 days')
    `.execute(db);
    await sql`
      INSERT INTO campanha_convites
        (id, campanha_id, email, criado_por, expira_em, consumido_em, consumido_por)
      VALUES (${ACEITO}, ${CAMP}, 'aceito@example.com', ${ATOR}, now() + interval '7 days', now(), ${ATOR})
    `.execute(db);
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  async function permissoes(id: string) {
    const { rows } = await sql<{ permissoes: string[] }>`
      SELECT permissoes FROM campanha_convites WHERE id = ${id}
    `.execute(db);
    return rows[0]?.permissoes;
  }

  it('backfills existing invites (pending included) with the default member permissions', async () => {
    await up(db);
    expect(await permissoes(PENDENTE)).toEqual([...PERMISSOES_PADRAO_MEMBRO]);
    expect(await permissoes(ACEITO)).toEqual([...PERMISSOES_PADRAO_MEMBRO]);
  });

  it('has no default afterwards: a raw insert must state the permissions', async () => {
    await up(db);
    await expect(
      sql`
        INSERT INTO campanha_convites (id, campanha_id, email, criado_por, expira_em)
        VALUES (gen_random_uuid(), ${CAMP}, 'novo@example.com', ${ATOR}, now() + interval '7 days')
      `.execute(db),
    ).rejects.toThrow(/permissoes/);
  });

  it('rejects owner-only and unknown actions at the DB level', async () => {
    await up(db);
    for (const invalid of [['membros:gerenciar'], ['qualquer:coisa']]) {
      await expect(
        sql`UPDATE campanha_convites SET permissoes = ${invalid}::text[] WHERE id = ${PENDENTE}`.execute(
          db,
        ),
      ).rejects.toThrow(/check/i);
    }
    await sql`
      UPDATE campanha_convites SET permissoes = ARRAY['extrato:ver', 'saque:solicitar']::text[]
      WHERE id = ${PENDENTE}
    `.execute(db);
    expect(await permissoes(PENDENTE)).toEqual(['extrato:ver', 'saque:solicitar']);
  });

  it('down drops only the column', async () => {
    await up(db);
    await down(db);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'campanha_convites' AND column_name = 'permissoes'
    `.execute(db);
    expect(rows[0]?.n).toBe(0);
    expect(await sql`SELECT id FROM campanha_convites`.execute(db)).toMatchObject({
      rows: [{ id: PENDENTE }, { id: ACEITO }],
    });
  });
});
