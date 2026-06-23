import { afterAll, beforeAll } from 'vitest';
import { PerfilCriadorRepositoryPostgres } from '../../src/adapters/usuario/perfil-criador-repository.postgres.js';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import { createTestObservability } from '../helpers/observability.js';
import { describePerfilCriadorRepositoryConformance } from '../helpers/perfil-criador-repository.conformance.js';
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

describePerfilCriadorRepositoryConformance('Postgres', {
  factory: () => ({
    perfilCriadorRepository: new PerfilCriadorRepositoryPostgres(testDb.db),
    usuarioRepository: new UsuarioRepositoryPostgres(testDb.db),
  }),
  resetState: async () => {
    // perfil_criadores FK → usuarios ON DELETE CASCADE, but delete it
    // explicitly first for clarity and FK-direction independence.
    await testDb.db.deleteFrom('perfil_criadores').execute();
    await truncateUsuarioTables(testDb.db);
  },
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});
