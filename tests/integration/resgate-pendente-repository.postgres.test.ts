import { afterAll, beforeAll } from 'vitest';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import { ResgatePendenteRepositoryPostgres } from '../../src/adapters/usuario/resgate-pendente-repository.postgres.js';
import { createTestObservability } from '../helpers/observability.js';
import { describeResgatePendenteRepositoryConformance } from '../helpers/resgate-pendente-repository.conformance.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateUsuarioTables } from '../helpers/truncate-usuario.js';

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
  factory: () => ({
    resgatePendenteRepository: new ResgatePendenteRepositoryPostgres(testDb.db),
    usuarioRepository: new UsuarioRepositoryPostgres(testDb.db),
  }),
  resetState: async () => {
    // resgates_pendentes FK → usuarios ON DELETE CASCADE; delete it explicitly
    // first for clarity and FK-direction independence.
    await testDb.db.deleteFrom('resgates_pendentes').execute();
    await truncateUsuarioTables(testDb.db);
  },
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});
