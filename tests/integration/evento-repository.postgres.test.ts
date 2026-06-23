import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { ConviteRepositoryPostgres } from '../../src/adapters/evento/convite-repository.postgres.js';
import { EventoRepositoryPostgres } from '../../src/adapters/evento/evento-repository.postgres.js';
import { ListaDeConvidadosRepositoryPostgres } from '../../src/adapters/evento/lista-de-convidados-repository.postgres.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import { criarCampanhaSemRecebedor } from '../../src/domain/arrecadacao/entities/campanha.js';
import { makeConvite } from '../helpers/convite-repository.conformance.js';
import {
  describeEventoRepositoryConformance,
  makeEvento,
} from '../helpers/evento-repository.conformance.js';
import { makeListaDeConvidados } from '../helpers/lista-de-convidados-repository.conformance.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';
import { truncateEventoTables } from '../helpers/truncate-evento.js';

let testDb: TestDatabase;
const testObs = createTestObservability();
const seededCampanhas = new Set<string>();

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

async function resetState() {
  seededCampanhas.clear();
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

describeEventoRepositoryConformance('Postgres', {
  factory: () => new EventoRepositoryPostgres(testDb.db),
  saveEvento: async (repo, evento) => {
    await ensureCampanhaExists(evento.idCampanha);
    await repo.save(evento);
  },
  resetState,
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});

describe('EventoRepositoryPostgres — Postgres-specific', () => {
  let repo: EventoRepositoryPostgres;

  beforeEach(async () => {
    await resetState();
    testObs.reset();
    repo = new EventoRepositoryPostgres(testDb.db);
  });

  it('delete cascades convite and lista linked to the event', async () => {
    const evento = makeEvento();
    await ensureCampanhaExists(evento.idCampanha);
    await repo.save(evento);

    const conviteRepository = new ConviteRepositoryPostgres(testDb.db);
    const listaRepository = new ListaDeConvidadosRepositoryPostgres(testDb.db);

    const convite = makeConvite({ idEvento: evento.id });
    const lista = makeListaDeConvidados({ idEvento: evento.id });

    await conviteRepository.save(convite);
    await listaRepository.save(lista);

    await repo.delete(evento.id);

    expect(await conviteRepository.findById(convite.id)).toBeUndefined();
    expect(await listaRepository.findById(lista.id)).toBeUndefined();
  });
});
