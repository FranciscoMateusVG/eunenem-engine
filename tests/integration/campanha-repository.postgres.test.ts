import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import {
  createArrecadacaoMemoryRepos,
  saveCampanhaComRecebedorAtivo,
} from '../helpers/arrecadacao-repos.js';
import {
  describeCampanhaRepositoryConformance,
  makeCampanha,
} from '../helpers/campanha-repository.conformance.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

// Hook timeout bumped to 180s — without the m4xaj globalSetup fix on
// this branch, container startup under docker daemon stress can exceed
// 60s. The structural fix lands in PR #92 (aperture-m4xaj); rebasing
// 2ma52 onto staging post-merge inherits it and this bump can come back
// down.
beforeAll(async () => {
  testDb = await createTestDatabase();
}, 180000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

describeCampanhaRepositoryConformance('Postgres', {
  factory: () => {
    const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
    return new CampanhaRepositoryPostgres(testDb.db, recebedorRepository);
  },
  saveCampanha: async (repo, campanha) => {
    const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
    const repos = {
      ...createArrecadacaoMemoryRepos(),
      campanhaRepository: repo,
      recebedorRepository,
    };
    await saveCampanhaComRecebedorAtivo(repos, campanha);
  },
  resetState: () => truncateArrecadacaoTables(testDb.db),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});

// ───── Postgres-specific tests for findCampanhasByContribuinte
//       (aperture-2ma52). Memory adapter returns []; here we exercise
//       the actual JOIN through contribuicoes on contribuinte_email.

describe('CampanhaRepositoryPostgres — findCampanhasByContribuinte (aperture-2ma52)', () => {
  let campanhaRepo: CampanhaRepositoryPostgres;
  let contribuicaoRepo: ContribuicaoRepositoryPostgres;

  beforeEach(async () => {
    await truncateArrecadacaoTables(testDb.db);
    const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
    campanhaRepo = new CampanhaRepositoryPostgres(testDb.db, recebedorRepository);
    contribuicaoRepo = new ContribuicaoRepositoryPostgres(testDb.db);
  });

  const seedCampanhaWithOpcao = async (overrides: { idPlataforma?: string } = {}) => {
    const campanha = makeCampanha({
      ...overrides,
      opcoes: [{ id: randomUUID(), tipo: 'presente' }],
    });
    const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
    await saveCampanhaComRecebedorAtivo(
      {
        ...createArrecadacaoMemoryRepos(),
        campanhaRepository: campanhaRepo,
        recebedorRepository,
      },
      campanha,
    );
    return campanha;
  };

  it('returns campanhas the contribuinte_email has contributed to', async () => {
    const idPlataforma = randomUUID();
    const campanhaA = await seedCampanhaWithOpcao({ idPlataforma });
    const campanhaB = await seedCampanhaWithOpcao({ idPlataforma });
    const campanhaUntouched = await seedCampanhaWithOpcao({ idPlataforma });

    const email = 'maria@example.com';

    await contribuicaoRepo.save(
      makeContribuicaoComContribuinte(campanhaA.id, campanhaA.opcoes[0]?.id, 'Maria', email),
    );
    await contribuicaoRepo.save(
      makeContribuicaoComContribuinte(campanhaB.id, campanhaB.opcoes[0]?.id, 'Maria', email),
    );

    const results = await campanhaRepo.findCampanhasByContribuinte(idPlataforma, email);
    const ids = results.map((c) => c.id).sort();
    expect(ids).toEqual([campanhaA.id, campanhaB.id].sort());
    expect(ids).not.toContain(campanhaUntouched.id);
  });

  it('returns DISTINCT campanhas — multiple contribuicoes to the same campanha count once', async () => {
    const idPlataforma = randomUUID();
    const campanha = await seedCampanhaWithOpcao({ idPlataforma });
    const email = 'gives-twice@example.com';

    await contribuicaoRepo.save(
      makeContribuicaoComContribuinte(campanha.id, campanha.opcoes[0]?.id, 'GT', email),
    );
    await contribuicaoRepo.save(
      makeContribuicaoComContribuinte(campanha.id, campanha.opcoes[0]?.id, 'GT', email),
    );

    const results = await campanhaRepo.findCampanhasByContribuinte(idPlataforma, email);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(campanha.id);
  });

  it('is case-insensitive on email match', async () => {
    const idPlataforma = randomUUID();
    const campanha = await seedCampanhaWithOpcao({ idPlataforma });

    await contribuicaoRepo.save(
      makeContribuicaoComContribuinte(
        campanha.id,
        campanha.opcoes[0]?.id,
        'CaseTest',
        'Maria.Silva@Example.COM',
      ),
    );

    const results = await campanhaRepo.findCampanhasByContribuinte(
      idPlataforma,
      'maria.silva@example.com',
    );
    expect(results.map((c) => c.id)).toEqual([campanha.id]);
  });

  it('respects tenant scope — different plataforma is not returned', async () => {
    const idPlataformaA = randomUUID();
    const idPlataformaB = randomUUID();
    const campanhaA = await seedCampanhaWithOpcao({ idPlataforma: idPlataformaA });
    const campanhaB = await seedCampanhaWithOpcao({ idPlataforma: idPlataformaB });
    const email = 'multi-tenant@example.com';

    await contribuicaoRepo.save(
      makeContribuicaoComContribuinte(campanhaA.id, campanhaA.opcoes[0]?.id, 'MT', email),
    );
    await contribuicaoRepo.save(
      makeContribuicaoComContribuinte(campanhaB.id, campanhaB.opcoes[0]?.id, 'MT', email),
    );

    const fromA = await campanhaRepo.findCampanhasByContribuinte(idPlataformaA, email);
    expect(fromA.map((c) => c.id)).toEqual([campanhaA.id]);

    const fromB = await campanhaRepo.findCampanhasByContribuinte(idPlataformaB, email);
    expect(fromB.map((c) => c.id)).toEqual([campanhaB.id]);
  });

  it('returns empty array when email has no contributions', async () => {
    const idPlataforma = randomUUID();
    await seedCampanhaWithOpcao({ idPlataforma });

    const results = await campanhaRepo.findCampanhasByContribuinte(
      idPlataforma,
      'no-contributions@example.com',
    );
    expect(results).toEqual([]);
  });

  it('returns empty array on empty email input', async () => {
    const results = await campanhaRepo.findCampanhasByContribuinte(randomUUID(), '');
    expect(results).toEqual([]);
  });
});

// ───── helper for building an "indisponivel" contribuicao with a known
//       contribuinte. Uses the entity factories so we always produce a
//       valid aggregate.

import {
  contribuicaoComContribuinte,
  criarContribuicaoDisponivel,
} from '../../src/domain/arrecadacao/entities/contribuicao.js';
import type {
  IdCampanha,
  IdOpcaoContribuicao,
} from '../../src/domain/arrecadacao/value-objects/ids.js';

function makeContribuicaoComContribuinte(
  idCampanha: string,
  idOpcao: string | undefined,
  contribuinteNome: string,
  contribuinteEmail: string,
) {
  const base = criarContribuicaoDisponivel({
    id: randomUUID() as never,
    idCampanha: idCampanha as IdCampanha,
    idOpcaoContribuicao: (idOpcao ?? randomUUID()) as IdOpcaoContribuicao,
    nome: 'Test Item',
    valor: 5000 as never,
    imagemUrl: null,
    grupo: null,
    criadaEm: new Date(),
  });
  return contribuicaoComContribuinte(base, {
    nome: contribuinteNome,
    email: contribuinteEmail,
  });
}
