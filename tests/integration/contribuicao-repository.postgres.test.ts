import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { saveCampanhaComRecebedorAtivo } from '../helpers/arrecadacao-repos.js';
import { makeCampanha } from '../helpers/campanha-repository.conformance.js';
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
  const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
  const campanhaRepo = new CampanhaRepositoryPostgres(testDb.db, recebedorRepository);
  const campanha = makeCampanha({
    id: contribuicao.idCampanha,
    opcoes: [{ id: contribuicao.idOpcaoContribuicao, tipo: 'presente' }],
    titulo: 'Campanha conformance',
  });
  await saveCampanhaComRecebedorAtivo(
    { campanhaRepository: campanhaRepo, recebedorRepository },
    campanha,
  );
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
  let recebedorRepository: RecebedorRepositoryPostgres;

  beforeEach(async () => {
    await truncateArrecadacaoTables(testDb.db);
    testObs.reset();
    recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
    campanhaRepo = new CampanhaRepositoryPostgres(testDb.db, recebedorRepository);
    contribuicaoRepo = new ContribuicaoRepositoryPostgres(testDb.db);
  });

  it('persists contribution with FK to campaign and option', async () => {
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const campanha = makeCampanha({
      id: idCampanha,
      opcoes: [{ id: idOpcao, tipo: 'convite' }],
      titulo: 'Campanha FK',
    });
    await saveCampanhaComRecebedorAtivo(
      { campanhaRepository: campanhaRepo, recebedorRepository },
      campanha,
    );

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
    expect(found?.nome).toBe('Convite VIP');
  });
});
