/**
 * Postgres adapter integration tests for `LivroFinanceiroRepository`
 * (aperture-id3ay).
 *
 * Covers the port contract end-to-end against a real Postgres container:
 *   - saveLancamentos + findLancamentosByIdPagamento round-trip
 *   - idempotency guard via UNIQUE (id_pagamento, tipo) surfacing
 *     FinanceiroPagamentoJaRegistradoError
 *   - findLancamentosByIdCampanha filters by id_campanha (incl. NULLs
 *     are not returned, since receita_plataforma lancamentos have no
 *     id_campanha)
 *   - findLancamentosReceitaPlataforma filters by tipo
 *   - saveRepasse + findRepasseById + findRepassesByIdCampanha
 *   - findRecebedorAtivoPorIdCampanha delegates to the injected
 *     RecebedorRepository (undefined when no repo injected)
 *
 * Persistence-survives-restart is not directly tested here — the
 * round-trip via Postgres is sufficient evidence (the container itself
 * provides durable storage; the prior memory adapter's data did not
 * survive a new instance of the adapter, which IS structurally
 * equivalent to a server restart).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/financeiro/livro-repository.postgres.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../src/domain/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../src/domain/financeiro/entities/repasse-recebedor.js';
import type {
  IdContribuicaoReferencia,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
} from '../../src/domain/financeiro/value-objects/ids.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../src/errors/financeiro/pagamento-ja-registrado.error.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
});

// Helpers — keep test code declarative.
function makeLancamentoRecebedor(overrides?: Partial<LancamentoFinanceiro>): LancamentoFinanceiro {
  return {
    id: randomUUID() as IdLancamentoFinanceiro,
    idPagamento: randomUUID() as IdPagamentoReferencia,
    idContribuicao: randomUUID() as IdContribuicaoReferencia,
    idCampanha: randomUUID() as IdCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: 1000,
    status: 'pendente',
    criadoEm: new Date('2026-05-31T12:00:00Z'),
    ...overrides,
  };
}

function makeLancamentoReceita(overrides?: Partial<LancamentoFinanceiro>): LancamentoFinanceiro {
  return {
    id: randomUUID() as IdLancamentoFinanceiro,
    idPagamento: randomUUID() as IdPagamentoReferencia,
    idContribuicao: randomUUID() as IdContribuicaoReferencia,
    // idCampanha intentionally omitted — receita_plataforma rows have no campanha
    tipo: 'credito_receita_plataforma',
    amountCents: 100,
    status: 'disponivel',
    criadoEm: new Date('2026-05-31T12:00:00Z'),
    ...overrides,
  };
}

function makeRepasse(overrides?: Partial<RepasseRecebedor>): RepasseRecebedor {
  return {
    id: randomUUID() as IdRepasse,
    idCampanha: randomUUID() as IdCampanha,
    amountCents: 5000,
    status: 'solicitado',
    solicitadoEm: new Date('2026-05-31T13:00:00Z'),
    ...overrides,
  };
}

describe('LivroFinanceiroRepositoryPostgres — lancamentos', () => {
  let repo: LivroFinanceiroRepositoryPostgres;

  beforeEach(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('lancamentos_financeiros').execute();
    repo = new LivroFinanceiroRepositoryPostgres(testDb.db);
  });

  it('saveLancamentos + findLancamentosByIdPagamento — round-trip preserves both rows', async () => {
    const idPagamento = randomUUID() as IdPagamentoReferencia;
    const idContribuicao = randomUUID() as IdContribuicaoReferencia;
    const idCampanha = randomUUID() as IdCampanha;

    const recebedor = makeLancamentoRecebedor({ idPagamento, idContribuicao, idCampanha });
    const receita = makeLancamentoReceita({ idPagamento, idContribuicao });

    await repo.saveLancamentos([recebedor, receita]);

    const found = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(found).toHaveLength(2);

    const foundRecebedor = found.find((l) => l.tipo === 'credito_saldo_recebedor');
    const foundReceita = found.find((l) => l.tipo === 'credito_receita_plataforma');

    expect(foundRecebedor).toMatchObject({
      id: recebedor.id,
      idPagamento,
      idContribuicao,
      idCampanha,
      tipo: 'credito_saldo_recebedor',
      amountCents: 1000,
      status: 'pendente',
    });
    expect(foundReceita).toMatchObject({
      id: receita.id,
      idPagamento,
      idContribuicao,
      idCampanha: undefined, // NULL → undefined
      tipo: 'credito_receita_plataforma',
      amountCents: 100,
      status: 'disponivel',
    });
  });

  it('saveLancamentos — duplicate (id_pagamento, tipo) throws FinanceiroPagamentoJaRegistradoError', async () => {
    const idPagamento = randomUUID() as IdPagamentoReferencia;
    const idContribuicao = randomUUID() as IdContribuicaoReferencia;
    const idCampanha = randomUUID() as IdCampanha;

    // First insert — succeeds.
    await repo.saveLancamentos([
      makeLancamentoRecebedor({ idPagamento, idContribuicao, idCampanha }),
      makeLancamentoReceita({ idPagamento, idContribuicao }),
    ]);

    // Second insert with same idPagamento — must reject. New uuid for the
    // lancamento PK so we collide only on (id_pagamento, tipo), not on id.
    await expect(
      repo.saveLancamentos([
        makeLancamentoRecebedor({ idPagamento, idContribuicao, idCampanha }),
        makeLancamentoReceita({ idPagamento, idContribuicao }),
      ]),
    ).rejects.toBeInstanceOf(FinanceiroPagamentoJaRegistradoError);
  });

  it('saveLancamentos — empty array is a no-op', async () => {
    await expect(repo.saveLancamentos([])).resolves.toBeUndefined();

    const found = await repo.findLancamentosByIdPagamento(randomUUID() as IdPagamentoReferencia);
    expect(found).toEqual([]);
  });

  it('findLancamentosByIdPagamento — returns empty array when no lancamentos exist', async () => {
    const found = await repo.findLancamentosByIdPagamento(randomUUID() as IdPagamentoReferencia);
    expect(found).toEqual([]);
  });

  it('findLancamentosByIdCampanha — returns only campanha-matching rows', async () => {
    const idCampanha = randomUUID() as IdCampanha;
    const otherCampanha = randomUUID() as IdCampanha;

    // Two payments on idCampanha (recebedor + receita each), one on otherCampanha.
    const idPagamentoA = randomUUID() as IdPagamentoReferencia;
    const idPagamentoB = randomUUID() as IdPagamentoReferencia;
    const idPagamentoC = randomUUID() as IdPagamentoReferencia;

    await repo.saveLancamentos([
      makeLancamentoRecebedor({ idPagamento: idPagamentoA, idCampanha }),
      makeLancamentoReceita({ idPagamento: idPagamentoA }),
    ]);
    await repo.saveLancamentos([
      makeLancamentoRecebedor({ idPagamento: idPagamentoB, idCampanha }),
      makeLancamentoReceita({ idPagamento: idPagamentoB }),
    ]);
    await repo.saveLancamentos([
      makeLancamentoRecebedor({ idPagamento: idPagamentoC, idCampanha: otherCampanha }),
      makeLancamentoReceita({ idPagamento: idPagamentoC }),
    ]);

    const found = await repo.findLancamentosByIdCampanha(idCampanha);
    expect(found).toHaveLength(2); // only the two recebedor rows; receita rows have no idCampanha
    expect(found.every((l) => l.idCampanha === idCampanha)).toBe(true);
    expect(found.every((l) => l.tipo === 'credito_saldo_recebedor')).toBe(true);
  });

  it('findLancamentosReceitaPlataforma — returns only receita_plataforma rows', async () => {
    const idPagamentoA = randomUUID() as IdPagamentoReferencia;
    const idPagamentoB = randomUUID() as IdPagamentoReferencia;

    await repo.saveLancamentos([
      makeLancamentoRecebedor({ idPagamento: idPagamentoA }),
      makeLancamentoReceita({ idPagamento: idPagamentoA, amountCents: 50 }),
    ]);
    await repo.saveLancamentos([
      makeLancamentoRecebedor({ idPagamento: idPagamentoB }),
      makeLancamentoReceita({ idPagamento: idPagamentoB, amountCents: 75 }),
    ]);

    const receitas = await repo.findLancamentosReceitaPlataforma();
    expect(receitas).toHaveLength(2);
    expect(receitas.every((l) => l.tipo === 'credito_receita_plataforma')).toBe(true);
    const totalReceita = receitas.reduce((acc, l) => acc + l.amountCents, 0);
    expect(totalReceita).toBe(125);
  });
});

describe('LivroFinanceiroRepositoryPostgres — repasses', () => {
  let repo: LivroFinanceiroRepositoryPostgres;

  beforeEach(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('repasses_recebedor').execute();
    repo = new LivroFinanceiroRepositoryPostgres(testDb.db);
  });

  it('saveRepasse + findRepasseById — round-trip', async () => {
    const repasse = makeRepasse({ amountCents: 12345 });
    await repo.saveRepasse(repasse);

    const found = await repo.findRepasseById(repasse.id);
    expect(found).toMatchObject({
      id: repasse.id,
      idCampanha: repasse.idCampanha,
      amountCents: 12345,
      status: 'solicitado',
    });
  });

  it('findRepasseById — returns undefined when not found', async () => {
    const found = await repo.findRepasseById(randomUUID() as IdRepasse);
    expect(found).toBeUndefined();
  });

  it('findRepassesByIdCampanha — returns only matching repasses', async () => {
    const idCampanha = randomUUID() as IdCampanha;
    const otherCampanha = randomUUID() as IdCampanha;

    await repo.saveRepasse(makeRepasse({ idCampanha, amountCents: 100 }));
    await repo.saveRepasse(makeRepasse({ idCampanha, amountCents: 200 }));
    await repo.saveRepasse(makeRepasse({ idCampanha: otherCampanha, amountCents: 999 }));

    const found = await repo.findRepassesByIdCampanha(idCampanha);
    expect(found).toHaveLength(2);
    expect(found.every((r) => r.idCampanha === idCampanha)).toBe(true);
    const total = found.reduce((acc, r) => acc + r.amountCents, 0);
    expect(total).toBe(300);
  });

  it('findRepassesByIdCampanha — returns empty array when none exist', async () => {
    const found = await repo.findRepassesByIdCampanha(randomUUID() as IdCampanha);
    expect(found).toEqual([]);
  });
});

describe('LivroFinanceiroRepositoryPostgres — findRecebedorAtivoPorIdCampanha', () => {
  it('returns undefined when no RecebedorRepository is injected', async () => {
    const repo = new LivroFinanceiroRepositoryPostgres(testDb.db);
    const found = await repo.findRecebedorAtivoPorIdCampanha(randomUUID() as IdCampanha);
    expect(found).toBeUndefined();
  });

  // Delegation-with-injected-repository is exercised via the integration
  // tests for the Arrecadação postgres adapter + the broader saga flow
  // tests (fluxo-jornada-completa.test.ts). Kept here as a focused unit
  // would duplicate that coverage without adding signal.
});
