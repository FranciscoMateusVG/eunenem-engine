import { afterAll, beforeAll } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { ConviteRepositoryPostgres } from '../../src/adapters/evento/convite-repository.postgres.js';
import { EventoRepositoryPostgres } from '../../src/adapters/evento/evento-repository.postgres.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import { criarCampanhaSemRecebedor } from '../../src/domain/arrecadacao/entities/campanha.js';
import { describeConviteRepositoryConformance } from '../helpers/convite-repository.conformance.js';
import { makeEvento } from '../helpers/evento-repository.conformance.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';
import { truncateEventoTables } from '../helpers/truncate-evento.js';

let testDb: TestDatabase;
const testObs = createTestObservability();
const seededCampanhas = new Set<string>();
const seededEventos = new Set<string>();

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

async function resetState() {
  seededCampanhas.clear();
  seededEventos.clear();
  await truncateEventoTables(testDb.db);
  await truncateArrecadacaoTables(testDb.db);
}

async function ensureCampanhaExists(idCampanha: string) {
  if (seededCampanhas.has(idCampanha)) {
    return;
  }

  const campanhaRepository = new CampanhaRepositoryPostgres(
    testDb.db,
    new RecebedorRepositoryPostgres(testDb.db),
  );

  await campanhaRepository.save(
    criarCampanhaSemRecebedor({
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [],
      titulo: `Campanha ${idCampanha}`,
      opcoes: [],
      criadaEm: new Date('2026-06-10T10:00:00.000Z'),
    }),
  );

  seededCampanhas.add(idCampanha);
}

async function ensureEventoExists(idEvento: string) {
  if (seededEventos.has(idEvento)) {
    return;
  }

  const eventoRepository = new EventoRepositoryPostgres(testDb.db);
  const evento = makeEvento({ id: idEvento });
  await ensureCampanhaExists(evento.idCampanha);
  await eventoRepository.save(evento);
  seededEventos.add(idEvento);
}

describeConviteRepositoryConformance('Postgres', {
  factory: () => new ConviteRepositoryPostgres(testDb.db),
  saveConvite: async (repo, convite) => {
    await ensureEventoExists(convite.idEvento);
    await repo.save(convite);
  },
  resetState,
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});
