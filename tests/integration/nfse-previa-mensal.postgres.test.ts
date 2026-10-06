import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadReceitaDashboard } from '../../apps/eunenem-server/server/admin-receita.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { ReceitaLedgerSeed } from '../helpers/receita-ledger-seed.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * aperture-uj78j — prévia mensal da NFS-e contra Postgres real.
 *
 * Datas em 2032: o container é compartilhado e admin-receita usa 2031.
 * NOW fica depois de todos os meses usados, salvo onde o teste diz o contrário.
 */

const OTHER_PLATFORM = '00000000-0000-4000-8000-00000000a5e1';
const NOW = new Date('2032-12-15T15:00:00.000Z');

let testDb: TestDatabase;
let seed: ReceitaLedgerSeed;

beforeAll(async () => {
  testDb = await createTestDatabase();
  seed = new ReceitaLedgerSeed(testDb.db);
}, 60_000);

beforeEach(async () => {
  await seed.wipe();
});

afterAll(async () => {
  await seed.wipe();
  await testDb.teardown();
});

function receitaDoMes(de: string, ate: string) {
  return loadReceitaDashboard(testDb.db, {
    platformId: ID_PLATAFORMA_EUNENEM,
    periodo: { de, ate, granularidade: 'mes' },
    now: NOW,
  });
}

/**
 * Cenário de bordas usado por vários testes. Março/2032 em SP vai de
 * 2032-03-01T03:00Z até 2032-04-01T03:00Z (BRT, UTC−3, sem horário de verão).
 */
async function seedBordasDeMarco() {
  const campanha = await seed.campanha();
  // 28/02 23:59:59 em SP ⇒ fevereiro, embora já seja março em UTC.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 7,
    criadoEm: new Date('2032-03-01T02:59:59Z'),
  });
  // 01/03 00:00 em SP ⇒ março.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 100,
    criadoEm: new Date('2032-03-01T03:00:00Z'),
  });
  // 31/03 23:59 em SP ⇒ março, embora já seja abril em UTC.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 20,
    criadoEm: new Date('2032-04-01T02:59:00Z'),
  });
  // 01/04 00:00 em SP ⇒ abril.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 3000,
    criadoEm: new Date('2032-04-01T03:00:00Z'),
  });
  // Março, cancelada em abril: conta +500 em março e −500 em abril.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 500,
    criadoEm: new Date('2032-03-10T15:00:00Z'),
    canceladoEm: new Date('2032-04-05T15:00:00Z'),
    status: 'estornado',
  });
  // Abril, cancelada em maio: maio fica negativo (−4000).
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 4000,
    criadoEm: new Date('2032-04-20T15:00:00Z'),
    canceladoEm: new Date('2032-05-02T15:00:00Z'),
    status: 'estornado',
  });
  // Adicional de cartão em março: não é receita.
  await seed.taxa({
    campaignId: campanha,
    taxaCents: 1,
    criadoEm: new Date('2032-03-15T15:00:00Z'),
    metodo: 'credit_card',
    adicionalCents: 9999,
  });
  // Outra plataforma em março: fora.
  const alheia = await seed.campanha(OTHER_PLATFORM);
  await seed.taxa({
    campaignId: alheia,
    taxaCents: 77777,
    criadoEm: new Date('2032-03-15T15:00:00Z'),
  });
}

/** Esperado por mês em SP, derivado à mão das linhas acima. */
const ESPERADO = {
  '2032-02': 7,
  '2032-03': 100 + 20 + 500 + 1, // 621
  '2032-04': 3000 + 4000 - 500, // 6500
  '2032-05': -4000,
  '2032-06': 0,
} as const;

describe('fixtures de borda provadas pela Receita (pré-condição da prévia)', () => {
  it('loadReceitaDashboard enxerga cada mês como derivado à mão', async () => {
    await seedBordasDeMarco();
    const meses = [
      ['2032-02', '2032-02-01', '2032-03-01'],
      ['2032-03', '2032-03-01', '2032-04-01'],
      ['2032-04', '2032-04-01', '2032-05-01'],
      ['2032-05', '2032-05-01', '2032-06-01'],
      ['2032-06', '2032-06-01', '2032-07-01'],
    ] as const;
    for (const [mes, de, ate] of meses) {
      const d = await receitaDoMes(de, ate);
      expect(d.cards.periodo.resultadoDeTaxasCents, mes).toBe(ESPERADO[mes]);
    }
  });
});
