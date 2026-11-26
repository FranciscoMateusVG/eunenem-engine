import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * aperture-wp6j6 — scripts/nfse-smoke-seed.ts executado de verdade contra o
 * Postgres de teste (descartável): semeia, é idempotente, e recusa se o
 * recebedor da campanha sintética não for mais o fictício.
 */

const run = promisify(execFile);
const MES = '2031-07'; // mês sem taxa em nenhum outro arquivo de teste
let testDb: TestDatabase;

async function seed(args: string[] = ['--banco-descartavel']) {
  try {
    const r = await run(
      'pnpm',
      ['exec', 'tsx', 'scripts/nfse-smoke-seed.ts', ...args, '--mes', MES],
      {
        env: { ...process.env, DATABASE_URL: testDb.connectionUri },
      },
    );
    return { ok: true, saida: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, saida: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const campanhas = async () =>
  (
    await sql<{
      id: string;
    }>`SELECT id FROM campanhas WHERE titulo = ${`NFSE SMOKE SINTETICO ${MES}`}`.execute(testDb.db)
  ).rows;

beforeAll(async () => {
  testDb = await createTestDatabase();
  if (!/@(localhost|127\.0\.0\.1):/.test(testDb.connectionUri))
    throw new Error('o teste exige Postgres local');
}, 60_000);

afterAll(async () => {
  for (const { id } of await campanhas()) {
    await sql`DELETE FROM lancamentos_financeiros WHERE id_pagamento IN (SELECT id FROM pagamentos WHERE intencao_id_campanha = ${id}::uuid)`.execute(
      testDb.db,
    );
  }
  await testDb.teardown();
});

describe('nfse-smoke-seed', () => {
  it('sem --banco-descartavel recusa sem tocar no banco', async () => {
    const r = await seed([]);
    expect(r.ok).toBe(false); // recusa = exit code 1
    expect(r.saida).toContain('passe --banco-descartavel');
    expect(await campanhas()).toHaveLength(0);
  });

  it('semeia uma vez; a 2ª execução reconhece o seed (recebedor fictício conferido) e não duplica', async () => {
    const primeira = await seed();
    expect(primeira).toMatchObject({ ok: true });
    expect(primeira.saida).toContain('tomador fictício');
    const segunda = await seed();
    expect(segunda).toMatchObject({ ok: true });
    expect(segunda.saida).toContain('já semeado');
    expect(await campanhas()).toHaveLength(1);
  }, 60_000);

  it('recebedor trocado na campanha sintética: recusa em vez de tratar como seed', async () => {
    const [c] = await campanhas();
    await sql`UPDATE recebedores SET cpf_titular = '11144477735' WHERE campanha_id = ${c?.id}::uuid`.execute(
      testDb.db,
    );
    const r = await seed();
    expect(r.ok).toBe(false);
    expect(r.saida).toContain('Recusado: 1 outra(s) campanha(s)');
    expect(await campanhas()).toHaveLength(1);
  }, 60_000);
});
