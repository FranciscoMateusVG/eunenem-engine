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
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type {
  IdContribuicaoReferencia,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
} from '../../src/domain/pagamentos/financeiro/value-objects/ids.js';
import type { IdItemDoPagamento } from '../../src/domain/pagamentos/value-objects/ids.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../src/errors/pagamentos/financeiro/pagamento-ja-registrado.error.js';
import { withLancamentoSeeding } from '../helpers/seed-lancamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
});

// Helpers — keep test code declarative.
// Plan 0015 (migration 019): LancamentoFinanceiro lost its `status` enum
// and `maturaEm` column. State is now derived from transferidoEm +
// canceladoEm (both nullable; null = "a receber" / repasse-eligible).
// Plan 0016 Phase 2 (migration 023): NOT-NULL `idItemPagamento` FK to
// intencao_items.id; `idRepasse` (aperture-s03dr) links a swept
// lançamento to its RepasseRecebedor.
function makeLancamentoRecebedor(overrides?: Partial<LancamentoFinanceiro>): LancamentoFinanceiro {
  return {
    id: randomUUID() as IdLancamentoFinanceiro,
    idPagamento: randomUUID() as IdPagamentoReferencia,
    idItemPagamento: randomUUID() as IdItemDoPagamento,
    idContribuicao: randomUUID() as IdContribuicaoReferencia,
    idCampanha: randomUUID() as IdCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: 1000,
    criadoEm: new Date('2026-05-31T12:00:00Z'),
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
    ...overrides,
  };
}

function makeLancamentoReceita(overrides?: Partial<LancamentoFinanceiro>): LancamentoFinanceiro {
  return {
    id: randomUUID() as IdLancamentoFinanceiro,
    idPagamento: randomUUID() as IdPagamentoReferencia,
    idItemPagamento: randomUUID() as IdItemDoPagamento,
    idContribuicao: randomUUID() as IdContribuicaoReferencia,
    // idCampanha intentionally omitted — receita_plataforma rows have no campanha
    tipo: 'credito_receita_plataforma',
    amountCents: 100,
    criadoEm: new Date('2026-05-31T12:00:00Z'),
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
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
    // aperture-s03dr: FSM extended to solicitado → aprovado. Solicitado
    // repasses carry null approval fields.
    aprovadoEm: null,
    bankTransferRef: null,
    ...overrides,
  };
}

describe('LivroFinanceiroRepositoryPostgres — lancamentos', () => {
  let repo: LivroFinanceiroRepositoryPostgres;

  beforeEach(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('lancamentos_financeiros').execute();
    repo = withLancamentoSeeding(new LivroFinanceiroRepositoryPostgres(testDb.db), testDb.db);
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
      // Plan 0015: status/maturaEm gone. A fresh lançamento is "a receber"
      // — transferidoEm + canceladoEm both null.
      transferidoEm: null,
      canceladoEm: null,
    });
    expect(foundReceita).toMatchObject({
      id: receita.id,
      idPagamento,
      idContribuicao,
      idCampanha: undefined, // NULL → undefined
      tipo: 'credito_receita_plataforma',
      amountCents: 100,
      transferidoEm: null,
      canceladoEm: null,
    });
  });

  it('saveLancamentos — duplicate (id_item_pagamento, tipo) throws FinanceiroPagamentoJaRegistradoError', async () => {
    const idPagamento = randomUUID() as IdPagamentoReferencia;
    const idItemPagamento = randomUUID() as IdItemDoPagamento;
    const idContribuicao = randomUUID() as IdContribuicaoReferencia;
    const idCampanha = randomUUID() as IdCampanha;

    // Plan 0016 Phase 2 (migration 023): the idempotency UNIQUE moved from
    // (id_pagamento, tipo) to (id_item_pagamento, tipo). Both saves below
    // share the SAME idItemPagamento so the recebedor+receita re-emit
    // collides on (id_item_pagamento, tipo).
    // First insert — succeeds.
    await repo.saveLancamentos([
      makeLancamentoRecebedor({ idPagamento, idItemPagamento, idContribuicao, idCampanha }),
      makeLancamentoReceita({ idPagamento, idItemPagamento, idContribuicao }),
    ]);

    // Second insert with same idItemPagamento — must reject. New uuid for
    // the lancamento PK so we collide only on (id_item_pagamento, tipo),
    // not on id.
    await expect(
      repo.saveLancamentos([
        makeLancamentoRecebedor({ idPagamento, idItemPagamento, idContribuicao, idCampanha }),
        makeLancamentoReceita({ idPagamento, idItemPagamento, idContribuicao }),
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

  // ───── aperture-bjshv: passthrough_surcharge persistence ─────────────

  function makeLancamentoPassthrough(
    overrides?: Partial<LancamentoFinanceiro>,
  ): LancamentoFinanceiro {
    return {
      id: randomUUID() as IdLancamentoFinanceiro,
      idPagamento: randomUUID() as IdPagamentoReferencia,
      idItemPagamento: randomUUID() as IdItemDoPagamento,
      idContribuicao: randomUUID() as IdContribuicaoReferencia,
      idCampanha: randomUUID() as IdCampanha, // passthrough inherits idCampanha
      tipo: 'credito_passthrough_surcharge',
      amountCents: 224,
      criadoEm: new Date('2026-06-02T12:00:00Z'),
      transferidoEm: null,
      canceladoEm: null,
      idRepasse: null,
      ...overrides,
    };
  }

  it('cartao 3-lancamento round-trip — passthrough row persists with correct tipo (aperture-bjshv)', async () => {
    const idPagamento = randomUUID() as IdPagamentoReferencia;
    const idContribuicao = randomUUID() as IdContribuicaoReferencia;
    const idCampanha = randomUUID() as IdCampanha;

    const recebedor = makeLancamentoRecebedor({
      idPagamento,
      idContribuicao,
      idCampanha,
      amountCents: 4500,
    });
    const receita = makeLancamentoReceita({ idPagamento, idContribuicao, amountCents: 225 });
    const passthrough = makeLancamentoPassthrough({
      idPagamento,
      idContribuicao,
      idCampanha,
      amountCents: 224,
    });

    await repo.saveLancamentos([recebedor, receita, passthrough]);

    const found = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(found).toHaveLength(3);
    const tipos = found.map((l) => l.tipo).sort();
    expect(tipos).toEqual(
      [
        'credito_passthrough_surcharge',
        'credito_receita_plataforma',
        'credito_saldo_recebedor',
      ].sort(),
    );

    const foundPassthrough = found.find((l) => l.tipo === 'credito_passthrough_surcharge');
    expect(foundPassthrough).toMatchObject({
      id: passthrough.id,
      idPagamento,
      idContribuicao,
      idCampanha,
      tipo: 'credito_passthrough_surcharge',
      amountCents: 224,
      // Plan 0015: status/maturaEm gone — derived from transferidoEm.
      transferidoEm: null,
      canceladoEm: null,
    });

    // Book-balance invariant survives postgres round-trip.
    const sum = found.reduce((acc, l) => acc + l.amountCents, 0);
    expect(sum).toBe(4500 + 225 + 224); // 4949
  });

  it('findLancamentosByIdCampanha — includes passthrough rows (they carry idCampanha) (aperture-bjshv)', async () => {
    const idCampanha = randomUUID() as IdCampanha;
    const idPagamento = randomUUID() as IdPagamentoReferencia;
    const idContribuicao = randomUUID() as IdContribuicaoReferencia;

    await repo.saveLancamentos([
      makeLancamentoRecebedor({ idPagamento, idContribuicao, idCampanha }),
      makeLancamentoReceita({ idPagamento, idContribuicao }),
      makeLancamentoPassthrough({ idPagamento, idContribuicao, idCampanha }),
    ]);

    const byCampanha = await repo.findLancamentosByIdCampanha(idCampanha);
    expect(byCampanha).toHaveLength(2);
    const tipos = byCampanha.map((l) => l.tipo).sort();
    expect(tipos).toEqual(['credito_passthrough_surcharge', 'credito_saldo_recebedor'].sort());
  });

  it('findLancamentosReceitaPlataforma — passthrough rows NOT included (different tipo) (aperture-bjshv)', async () => {
    const idPagamento = randomUUID() as IdPagamentoReferencia;
    const idContribuicao = randomUUID() as IdContribuicaoReferencia;
    const idCampanha = randomUUID() as IdCampanha;

    await repo.saveLancamentos([
      makeLancamentoRecebedor({ idPagamento, idContribuicao, idCampanha, amountCents: 4500 }),
      makeLancamentoReceita({ idPagamento, idContribuicao, amountCents: 225 }),
      makeLancamentoPassthrough({ idPagamento, idContribuicao, idCampanha, amountCents: 224 }),
    ]);

    const receitas = await repo.findLancamentosReceitaPlataforma();
    expect(receitas).toHaveLength(1);
    expect(receitas[0]?.tipo).toBe('credito_receita_plataforma');
    expect(receitas[0]?.amountCents).toBe(225);
    expect(receitas.find((l) => l.tipo === 'credito_passthrough_surcharge')).toBeUndefined();
  });

  it('CHECK constraint accepts credito_passthrough_surcharge (migration 015 applied) (aperture-bjshv)', async () => {
    // Direct probe: insert the new tipo with a hand-crafted row and
    // assert it doesn't trip the tipo CHECK constraint. If the migration
    // wasn't applied, the INSERT would raise a 23514 violation naming
    // `lancamentos_financeiros_tipo_check`.
    const passthrough = makeLancamentoPassthrough();
    await expect(repo.saveLancamentos([passthrough])).resolves.not.toThrow();

    const found = await repo.findLancamentosByIdPagamento(passthrough.idPagamento);
    expect(found).toHaveLength(1);
    expect(found[0]?.tipo).toBe('credito_passthrough_surcharge');
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

    // aperture-s03dr / migration 021: the partial unique index
    // `repasses_um_solicitado_por_campanha` allows at most ONE solicitado
    // repasse per campanha. To persist two repasses on the SAME campanha,
    // the second must be in the terminal `aprovado` state (which carries
    // aprovadoEm + an optional bankTransferRef).
    await repo.saveRepasse(makeRepasse({ idCampanha, amountCents: 100, status: 'solicitado' }));
    await repo.saveRepasse(
      makeRepasse({
        idCampanha,
        amountCents: 200,
        status: 'aprovado',
        aprovadoEm: new Date('2026-06-01T10:00:00Z'),
        bankTransferRef: 'E2E-REF-200',
      }),
    );
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

// ───── transferidoEm flow (Plan 0015 collapse — replaces aperture-led0r maturation) ─────
//
// Plan 0015 (migration 019) COLLAPSED the financeiro state machine. The
// `status: pendente|disponivel` enum + `maturaEm` column are gone, and so
// are `findPendentesMaturos` + `marcarComoDisponivel` (the FSM-flip
// methods). "A receber" / "já transferido" is now derived from the
// `transferidoEm` column: NULL = repasse-eligible; non-null = transferred.
// The mutation that stamps `transferidoEm` is
// `marcarLancamentosComoTransferidos` (the admin batch action), and
// `hasLancamentosTransferidos` exposes the estorno 409-gate predicate.
//
// The original aperture-led0r tests below are re-mapped onto that new API
// — each old assertion has a direct transferidoEm equivalent:
//   - "find pendente maturos"  → marcarComoTransferidos updates only the
//     un-transferred subset (the WHERE filters out already-transferred /
//     cancelled rows), observable via transferidoEm post-update.
//   - "flip pendente → disponivel" → marcarComoTransferidos stamps
//     transferidoEm on a previously-null row.
//   - "idempotent on already-disponivel" → marcarComoTransferidos is a
//     no-op on already-transferred rows (does not overwrite transferidoEm).
//   - "no-op on unknown id" → marcarComoTransferidos with an unknown id.
describe('LivroFinanceiroRepositoryPostgres — transferidoEm flow (Plan 0015)', () => {
  let repo: LivroFinanceiroRepositoryPostgres;

  beforeEach(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('lancamentos_financeiros').execute();
    repo = withLancamentoSeeding(new LivroFinanceiroRepositoryPostgres(testDb.db), testDb.db);
  });

  function makeRecebedorRow(overrides?: Partial<LancamentoFinanceiro>): LancamentoFinanceiro {
    return {
      id: randomUUID() as IdLancamentoFinanceiro,
      idPagamento: randomUUID() as IdPagamentoReferencia,
      idItemPagamento: randomUUID() as IdItemDoPagamento,
      idContribuicao: randomUUID() as IdContribuicaoReferencia,
      idCampanha: randomUUID() as IdCampanha,
      tipo: 'credito_saldo_recebedor',
      amountCents: 1000,
      criadoEm: new Date('2026-05-01T00:00:00Z'),
      transferidoEm: null,
      canceladoEm: null,
      idRepasse: null,
      ...overrides,
    };
  }

  it('marcarLancamentosComoTransferidos stamps transferidoEm ONLY on the un-transferred subset', async () => {
    const transferAt = new Date('2026-06-01T00:00:00Z');

    const naoTransferido = makeRecebedorRow();
    const jaTransferido = makeRecebedorRow({ transferidoEm: new Date('2026-05-10T00:00:00Z') });
    const cancelado = makeRecebedorRow({ canceladoEm: new Date('2026-05-12T00:00:00Z') });
    const foraDoBatch = makeRecebedorRow();

    await repo.saveLancamentos([naoTransferido, jaTransferido, cancelado, foraDoBatch]);

    // Only naoTransferido + cancelado + jaTransferido are in the batch;
    // the WHERE filters out the already-transferred + the cancelled, so
    // only naoTransferido actually flips.
    await repo.marcarLancamentosComoTransferidos(
      [naoTransferido.id, jaTransferido.id, cancelado.id],
      transferAt,
    );

    const after = await repo.findLancamentosByIds([
      naoTransferido.id,
      jaTransferido.id,
      cancelado.id,
      foraDoBatch.id,
    ]);
    const byId = new Map(after.map((l) => [l.id, l]));
    expect(byId.get(naoTransferido.id)?.transferidoEm).toEqual(transferAt);
    // already-transferred row keeps its ORIGINAL timestamp (not overwritten)
    expect(byId.get(jaTransferido.id)?.transferidoEm).toEqual(new Date('2026-05-10T00:00:00Z'));
    // cancelled row is never transferred
    expect(byId.get(cancelado.id)?.transferidoEm).toBeNull();
    // row outside the batch is untouched
    expect(byId.get(foraDoBatch.id)?.transferidoEm).toBeNull();
  });

  it('marcarLancamentosComoTransferidos flips a previously-null transferidoEm row', async () => {
    const transferAt = new Date('2026-06-01T00:00:00Z');
    const pendente = makeRecebedorRow();
    await repo.saveLancamentos([pendente]);

    expect(await repo.hasLancamentosTransferidos(pendente.idPagamento)).toBe(false);

    await repo.marcarLancamentosComoTransferidos([pendente.id], transferAt);

    const found = await repo.findLancamentosByIdPagamento(pendente.idPagamento);
    expect(found[0]?.transferidoEm).toEqual(transferAt);
    expect(await repo.hasLancamentosTransferidos(pendente.idPagamento)).toBe(true);
  });

  it('marcarLancamentosComoTransferidos is idempotent on already-transferred rows', async () => {
    const original = new Date('2026-05-15T00:00:00Z');
    const jaTransferido = makeRecebedorRow({ transferidoEm: original });
    await repo.saveLancamentos([jaTransferido]);

    // Call twice with a DIFFERENT timestamp — neither should throw, neither
    // should overwrite the original transferidoEm (the WHERE excludes
    // already-transferred rows).
    await expect(
      repo.marcarLancamentosComoTransferidos([jaTransferido.id], new Date('2026-07-01T00:00:00Z')),
    ).resolves.not.toThrow();
    await expect(
      repo.marcarLancamentosComoTransferidos([jaTransferido.id], new Date('2026-08-01T00:00:00Z')),
    ).resolves.not.toThrow();

    const found = await repo.findLancamentosByIdPagamento(jaTransferido.idPagamento);
    expect(found[0]?.transferidoEm).toEqual(original);
  });

  it('marcarLancamentosComoTransferidos on unknown id is a no-op', async () => {
    await expect(
      repo.marcarLancamentosComoTransferidos(
        [randomUUID() as IdLancamentoFinanceiro],
        new Date('2026-06-01T00:00:00Z'),
      ),
    ).resolves.not.toThrow();
  });
});
