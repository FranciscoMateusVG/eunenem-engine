import { afterAll, beforeAll } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { PerfilCampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/perfil-campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createTestObservability } from '../helpers/observability.js';
import { describePerfilCampanhaRepositoryConformance } from '../helpers/perfil-campanha-repository.conformance.js';
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

describePerfilCampanhaRepositoryConformance('Postgres', {
  factory: () => ({
    perfilCampanhaRepository: new PerfilCampanhaRepositoryPostgres(testDb.db),
    campanhaRepository: new CampanhaRepositoryPostgres(
      testDb.db,
      new RecebedorRepositoryPostgres(testDb.db),
    ),
  }),
  resetState: async () => {
    // perfil_campanhas FK → campanhas ON DELETE CASCADE, but delete it
    // explicitly first for clarity and FK-direction independence.
    await testDb.db.deleteFrom('perfil_campanhas').execute();
    await truncateArrecadacaoTables(testDb.db);
  },
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});
