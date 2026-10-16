import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { makeCampanha } from '../helpers/campanha-repository.conformance.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;
let repo: CampanhaRepositoryPostgres;
beforeAll(async () => {
  testDb = await createTestDatabase();
  repo = new CampanhaRepositoryPostgres(testDb.db, new RecebedorRepositoryPostgres(testDb.db));
}, 180000);
afterAll(async () => {
  await testDb?.teardown();
});

it('saving a stale campaign never removes a concurrently granted member', async () => {
  const campanha = makeCampanha();
  await repo.save(campanha);
  const member = randomUUID();
  await testDb.db
    .insertInto('campanha_administradores')
    .values({ campanha_id: campanha.id, id_usuario: member })
    .execute();
  await repo.save(campanha);
  const current = await repo.findById(campanha.id);
  expect(current?.idsAdministradores).toContain(member);
});

it('saving a stale campaign never resurrects a revoked member', async () => {
  const campanha = makeCampanha({ idsAdministradores: [randomUUID(), randomUUID()] });
  await repo.save(campanha);
  const member = campanha.idsAdministradores[1];
  if (!member) throw new Error('Missing fixture member');
  await testDb.db
    .deleteFrom('campanha_administradores')
    .where('campanha_id', '=', campanha.id)
    .where('id_usuario', '=', member)
    .execute();
  await repo.save(campanha);
  const current = await repo.findById(campanha.id);
  expect(current?.idsAdministradores).not.toContain(member);
});
