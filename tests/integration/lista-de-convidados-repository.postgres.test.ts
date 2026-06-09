import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { EventoRepositoryPostgres } from '../../src/adapters/evento/evento-repository.postgres.js';
import { ListaDeConvidadosRepositoryPostgres } from '../../src/adapters/evento/lista-de-convidados-repository.postgres.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import { criarCampanhaSemRecebedor } from '../../src/domain/arrecadacao/entities/campanha.js';
import { makeEvento } from '../helpers/evento-repository.conformance.js';
import {
  describeListaDeConvidadosRepositoryConformance,
  makeConvidado,
  makeListaDeConvidados,
} from '../helpers/lista-de-convidados-repository.conformance.js';
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

describeListaDeConvidadosRepositoryConformance('Postgres', {
  factory: () => new ListaDeConvidadosRepositoryPostgres(testDb.db),
  saveLista: async (repo, listaDeConvidados) => {
    await ensureEventoExists(listaDeConvidados.idEvento);
    await repo.save(listaDeConvidados);
  },
  resetState,
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});

describe('ListaDeConvidadosRepositoryPostgres — Postgres-specific', () => {
  let repo: ListaDeConvidadosRepositoryPostgres;

  beforeEach(async () => {
    await resetState();
    testObs.reset();
    repo = new ListaDeConvidadosRepositoryPostgres(testDb.db);
  });

  it('save rewrites the guest snapshot, removing convidados omitted from the new version', async () => {
    const convidadoA = makeConvidado({ nome: 'Aline' });
    const convidadoB = makeConvidado({ nome: 'Bruno' });
    const listaInicial = makeListaDeConvidados({
      convidados: [convidadoA, convidadoB],
    });
    await ensureEventoExists(listaInicial.idEvento);
    await repo.save(listaInicial);

    const listaAtualizada = {
      ...listaInicial,
      convidados: [{ ...convidadoA, presenca: 'sim' as const }],
      atualizadoEm: new Date('2026-06-21T12:00:00.000Z'),
    };
    await repo.save(listaAtualizada);

    const found = await repo.findById(listaInicial.id);
    expect(found).toEqual(listaAtualizada);
  });
});
