import { afterAll, beforeAll } from 'vitest';
import { DadosRecebimentoRepositoryPostgres } from '../../src/adapters/usuario/dados-recebimento-repository.postgres.js';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import { describeDadosRecebimentoRepositoryConformance } from '../helpers/dados-recebimento-repository.conformance.js';
import { createTestObservability } from '../helpers/observability.js';
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

describeDadosRecebimentoRepositoryConformance('Postgres', {
  factory: () => ({
    dadosRecebimentoRepository: new DadosRecebimentoRepositoryPostgres(testDb.db),
    usuarioRepository: new UsuarioRepositoryPostgres(testDb.db),
  }),
  resetState: async () => {
    // dados_recebimento_usuario FK → usuarios ON DELETE CASCADE; delete it
    // explicitly first for clarity and FK-direction independence.
    await testDb.db.deleteFrom('dados_recebimento_usuario').execute();
    await truncateUsuarioTables(testDb.db);
  },
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});
