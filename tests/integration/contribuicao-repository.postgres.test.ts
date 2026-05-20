import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { describeContribuicaoRepositoryConformance } from '../helpers/contribuicao-repository.conformance.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

async function seedCampanhaParaContribuicao(contribuicao: {
  idCampanha: string;
  idOpcaoContribuicao: string;
}): Promise<void> {
  const campanhaRepo = new CampanhaRepositoryPostgres(testDb.db);
  await campanhaRepo.save({
    id: contribuicao.idCampanha,
    idsAdministradores: [randomUUID()],
    idRecebedor: randomUUID(),
    dadosRecebedor: {
      nomeTitular: 'Maria',
      tipoChavePix: 'email',
      chavePix: 'maria@exemplo.com',
    },
    titulo: 'Campanha conformance',
    opcoes: [{ id: contribuicao.idOpcaoContribuicao, tipo: 'presente' }],
    criadaEm: new Date(),
  });
}

describeContribuicaoRepositoryConformance('Postgres', {
  factory: () => new ContribuicaoRepositoryPostgres(testDb.db),
  resetState: () => truncateArrecadacaoTables(testDb.db),
  seedForContribuicao: seedCampanhaParaContribuicao,
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});

describe('ContribuicaoRepositoryPostgres — Postgres-specific', () => {
  let campanhaRepo: CampanhaRepositoryPostgres;
  let contribuicaoRepo: ContribuicaoRepositoryPostgres;

  beforeEach(async () => {
    await truncateArrecadacaoTables(testDb.db);
    testObs.reset();
    campanhaRepo = new CampanhaRepositoryPostgres(testDb.db);
    contribuicaoRepo = new ContribuicaoRepositoryPostgres(testDb.db);
  });

  it('persists contribution with FK to campaign and option', async () => {
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idRecebedor = randomUUID();

    await campanhaRepo.save({
      id: idCampanha,
      idsAdministradores: [randomUUID()],
      idRecebedor,
      dadosRecebedor: {
        nomeTitular: 'Maria',
        tipoChavePix: 'email',
        chavePix: 'maria@exemplo.com',
      },
      titulo: 'Campanha FK',
      opcoes: [{ id: idOpcao, tipo: 'convite' }],
      criadaEm: new Date(),
    });

    const idContribuicao = randomUUID();
    await contribuicaoRepo.save({
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao: idOpcao,
      nome: 'Convite VIP',
      valor: 3000,
      contribuinte: null,
      status: 'disponivel',
      criadaEm: new Date(),
    });

    const found = await contribuicaoRepo.findById(idContribuicao);
    expect(found?.idCampanha).toBe(idCampanha);
    expect(found?.nome).toBe('Convite VIP');
    expect(found?.contribuinte).toBeNull();
  });
});
