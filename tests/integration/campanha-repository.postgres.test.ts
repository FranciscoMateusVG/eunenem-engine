import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
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

    await seedContribuinteAprovado({
      contribuicaoRepo,
      idCampanha: campanhaA.id,
      idOpcao: campanhaA.opcoes[0]?.id,
      contribuinteNome: 'Maria',
      contribuinteEmail: email,
    });
    await seedContribuinteAprovado({
      contribuicaoRepo,
      idCampanha: campanhaB.id,
      idOpcao: campanhaB.opcoes[0]?.id,
      contribuinteNome: 'Maria',
      contribuinteEmail: email,
    });

    const results = await campanhaRepo.findCampanhasByContribuinte(idPlataforma, email);
    const ids = results.map((c) => c.id).sort();
    expect(ids).toEqual([campanhaA.id, campanhaB.id].sort());
    expect(ids).not.toContain(campanhaUntouched.id);
  });

  it('returns DISTINCT campanhas — multiple contribuicoes to the same campanha count once', async () => {
    const idPlataforma = randomUUID();
    const campanha = await seedCampanhaWithOpcao({ idPlataforma });
    const email = 'gives-twice@example.com';

    // Two separate aprovado pagamentos (two distinct contribuições) on the
    // SAME campanha — the DISTINCT in the repo query must collapse them.
    await seedContribuinteAprovado({
      contribuicaoRepo,
      idCampanha: campanha.id,
      idOpcao: campanha.opcoes[0]?.id,
      contribuinteNome: 'GT',
      contribuinteEmail: email,
    });
    await seedContribuinteAprovado({
      contribuicaoRepo,
      idCampanha: campanha.id,
      idOpcao: campanha.opcoes[0]?.id,
      contribuinteNome: 'GT',
      contribuinteEmail: email,
    });

    const results = await campanhaRepo.findCampanhasByContribuinte(idPlataforma, email);
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(campanha.id);
  });

  it('is case-insensitive on email match', async () => {
    const idPlataforma = randomUUID();
    const campanha = await seedCampanhaWithOpcao({ idPlataforma });

    await seedContribuinteAprovado({
      contribuicaoRepo,
      idCampanha: campanha.id,
      idOpcao: campanha.opcoes[0]?.id,
      contribuinteNome: 'CaseTest',
      contribuinteEmail: 'Maria.Silva@Example.COM',
    });

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

    await seedContribuinteAprovado({
      contribuicaoRepo,
      idCampanha: campanhaA.id,
      idOpcao: campanhaA.opcoes[0]?.id,
      contribuinteNome: 'MT',
      contribuinteEmail: email,
    });
    await seedContribuinteAprovado({
      contribuicaoRepo,
      idCampanha: campanhaB.id,
      idOpcao: campanhaB.opcoes[0]?.id,
      contribuinteNome: 'MT',
      contribuinteEmail: email,
    });

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

// ───── helper for seeding the NEW (Plan 0015 + 0016) shape that
//       `findCampanhasByContribuinte` actually queries.
//
//   Plan 0015 (aperture-ucgok): contribuinte data moved OFF contribuicoes
//   ONTO pagamentos.intencao_contribuinte_* (email/nome/mensagem). The
//   Contribuição entity is now a pure admin-owned slot definition — no
//   status, no contribuinte. The factory `criarContribuicaoDisponivel`
//   was renamed `criarContribuicao` and `contribuicaoComContribuinte`
//   was removed.
//
//   Plan 0016 (aperture-aj8qw, migrations 022+023): a pagamento carries
//   N contribuição-tipo items in the separate `intencao_items` table
//   (id_contribuicao, id_pagamento, quantidade). The old per-pagamento
//   `intencao_id_contribuicao` column on `pagamentos` was retired.
//
//   So to make `findCampanhasByContribuinte(idPlataforma, email)` return
//   a campanha we must seed, per contribuição:
//     1. a contribuição slot (via `criarContribuicao` + repo) on the
//        campanha,
//     2. an APROVADO pagamento carrying `intencao_contribuinte_email = email`,
//     3. an `intencao_items` row of tipo 'contribuicao' pointing the
//        pagamento at that contribuição.
//   The repo joins campanhas → contribuicoes → intencao_items →
//   pagamentos and filters on the pagamento's contribuinte email +
//   status='aprovado'.

import { criarContribuicao } from '../../src/domain/arrecadacao/entities/contribuicao.js';
import type {
  IdCampanha,
  IdOpcaoContribuicao,
} from '../../src/domain/arrecadacao/value-objects/ids.js';

/**
 * Seed a contribuição slot + an aprovado pagamento (carrying the
 * contribuinte email) + the intencao_items row binding them. Mirrors the
 * post-0016 multi-item shape the repo query traverses.
 */
async function seedContribuinteAprovado(args: {
  contribuicaoRepo: ContribuicaoRepositoryPostgres;
  idCampanha: string;
  idOpcao: string | undefined;
  contribuinteNome: string;
  contribuinteEmail: string;
}): Promise<void> {
  const contribuicao = criarContribuicao({
    id: randomUUID() as never,
    idCampanha: args.idCampanha as IdCampanha,
    idOpcaoContribuicao: (args.idOpcao ?? randomUUID()) as IdOpcaoContribuicao,
    nome: 'Test Item',
    valor: 5000 as never,
    imagemUrl: null,
    grupo: null,
    quantidade: 1,
    criadaEm: new Date(),
  });
  await args.contribuicaoRepo.save(contribuicao);

  const pagamentoId = randomUUID();
  const intencaoId = randomUUID();
  // Aprovado pagamento carrying the contribuinte snapshot. The cart-scope
  // invariant FK `intencao_id_campanha` points at the same campanha the
  // contribuição belongs to.
  await sql`
    INSERT INTO pagamentos (
      id, status, criado_em, atualizado_em,
      intencao_id, intencao_id_campanha, intencao_metodo, intencao_criada_em,
      intencao_total_paid_cents, intencao_total_contribution_cents,
      intencao_total_fee_cents, intencao_total_receiver_cents,
      intencao_total_surcharge_cents,
      intencao_contribuinte_nome, intencao_contribuinte_email
    ) VALUES (
      ${pagamentoId}, 'aprovado', now(), now(),
      ${intencaoId}, ${args.idCampanha}, 'credit_card', now(),
      5000, 5000, 0, 5000, 0,
      ${args.contribuinteNome}, ${args.contribuinteEmail}
    )
  `.execute(testDb.db);

  // The contribuicao-tipo item linking the pagamento to the contribuição.
  await sql`
    INSERT INTO intencao_items (
      id, id_pagamento, id_intencao_pagamento, position, tipo,
      id_contribuicao, quantidade,
      contribution_unit_amount_cents, fee_unit_amount_cents,
      receiver_unit_amount_cents, line_contribution_amount_cents,
      line_fee_amount_cents, line_receiver_amount_cents,
      criado_em
    ) VALUES (
      ${randomUUID()}, ${pagamentoId}, ${intencaoId}, 0, 'contribuicao',
      ${contribuicao.id}, 1,
      5000, 0, 5000, 5000, 0, 5000,
      now()
    )
  `.execute(testDb.db);
}
