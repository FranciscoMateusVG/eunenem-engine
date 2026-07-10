import { afterAll, beforeAll } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { ResgatePendenteRepositoryPostgres } from '../../src/adapters/arrecadacao/resgate-pendente-repository.postgres.js';
import { createTestObservability } from '../helpers/observability.js';
import { describeResgatePendenteRepositoryConformance } from '../helpers/resgate-pendente-repository.conformance.js';
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

describeResgatePendenteRepositoryConformance('Postgres', {
  factory: () => {
    const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
    return {
      resgatePendenteRepository: new ResgatePendenteRepositoryPostgres(testDb.db),
      campanhaRepository: new CampanhaRepositoryPostgres(testDb.db, recebedorRepository),
    };
  },
  resetState: async () => {
    // resgates_pendentes FK → campanhas ON DELETE CASCADE; delete it
    // explicitly first (truncateArrecadacaoTables doesn't know about it),
    // then reuse the shared Arrecadação truncation order for the rest.
    await testDb.db.deleteFrom('resgates_pendentes').execute();
    await truncateArrecadacaoTables(testDb.db);
  },
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});
