import { afterAll, beforeAll } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createTestObservability } from '../helpers/observability.js';
import { describeRecebedorRepositoryConformance } from '../helpers/recebedor-repository.conformance.js';
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

describeRecebedorRepositoryConformance('Postgres', {
  factory: () => {
    const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
    const campanhaRepository = new CampanhaRepositoryPostgres(testDb.db, recebedorRepository);
    return { campanhaRepository, recebedorRepository };
  },
  resetState: () => truncateArrecadacaoTables(testDb.db),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});
