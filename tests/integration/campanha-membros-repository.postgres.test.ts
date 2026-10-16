import { sql } from 'kysely';
import { afterAll, beforeAll } from 'vitest';
import { CampanhaMembrosRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-membros-repository.postgres.js';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { describeCampanhaMembrosRepositoryConformance } from '../helpers/campanha-membros-repository.conformance.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

describeCampanhaMembrosRepositoryConformance('Postgres', {
  factory: async () => {
    const db = testDb.db;
    const campanhaRepository = new CampanhaRepositoryPostgres(
      db,
      new RecebedorRepositoryPostgres(db),
    );
    return {
      campanhaMembrosRepository: new CampanhaMembrosRepositoryPostgres(db),
      campanhaRepository,
      criarCampanha: async (campanha) => {
        await campanhaRepository.save(campanha);
        // Owner init for a NEW campanha (the aggregate save does this once
        // the sharing branch lands; idempotent here either way).
        await sql`
          INSERT INTO campanha_membros_permissoes (campanha_id, id_conta, papel)
          VALUES (${campanha.id}::uuid, ${campanha.idsAdministradores[0]}::uuid, 'owner')
          ON CONFLICT DO NOTHING
        `.execute(db);
      },
      adicionarAdministrador: async (idCampanha, idConta) => {
        await db
          .insertInto('campanha_administradores')
          .values({ campanha_id: idCampanha, id_usuario: idConta })
          .execute();
      },
      removerAdministrador: async (idCampanha, idConta) => {
        await db
          .deleteFrom('campanha_administradores')
          .where('campanha_id', '=', idCampanha)
          .where('id_usuario', '=', idConta)
          .execute();
      },
    };
  },
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});
