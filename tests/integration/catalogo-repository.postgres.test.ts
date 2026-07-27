import { afterAll, beforeAll } from 'vitest';
import { CatalogoRepositoryPostgres } from '../../src/adapters/catalogo/repository.postgres.js';
import { describeCatalogoRepositoryConformance } from '../helpers/catalogo-repository.conformance.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

describeCatalogoRepositoryConformance('Postgres', {
  factory: () => new CatalogoRepositoryPostgres(testDb.db),
  resetState: async () => {
    await testDb.db.deleteFrom('catalogo_lista_itens').execute();
    await testDb.db.deleteFrom('catalogo_listas').execute();
    await testDb.db.deleteFrom('catalogo_produtos').execute();
    await testDb.db.deleteFrom('catalogo_categorias').execute();
  },
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});
