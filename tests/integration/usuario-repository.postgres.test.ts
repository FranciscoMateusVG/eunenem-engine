import { afterAll, beforeAll } from 'vitest';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateUsuarioTables } from '../helpers/truncate-usuario.js';
import { describeUsuarioRepositoryConformance } from '../helpers/usuario-repository.conformance.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describeUsuarioRepositoryConformance('Postgres', {
  factory: () => new UsuarioRepositoryPostgres(testDb.db),
  resetState: () => truncateUsuarioTables(testDb.db),
});
