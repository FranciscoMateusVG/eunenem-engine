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
import { TransferenciaProviderFake } from '../../src/adapters/pagamentos/transferencia-provider.fake.js';
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
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';
import {
  confirmarTransferenciaRepasse,
  MAX_TENTATIVAS_CONFIRMACAO,
} from '../../src/use-cases/pagamentos/financeiro/confirmar-transferencia-repasse.js';
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
    // aperture-477nz — candidatos FK-references repasses_recebedor; delete the
    // child rows before the parent (shared-container suite, prior blocks may
    // have left candidatos).
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('repasse_reconciliacao_candidatos').execute();
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

/**
 * Transfer-FSM audit-row regression suite (aperture-vvh2j, GLaDOS money-flow
 * review 2026-07-16). These exercise resolverVerificacaoTransferencia and
 * cancelarRepasseTransaction against REAL Postgres — the memory adapter's
 * plain-push audit trail masked a (repasse_id, attempt_no) unique-constraint
 * collision: both methods used to INSERT an audit row reusing the intent
 * row's attempt_no, so in real Postgres they threw 23505 and rolled back —
 * confirmed payments never booked and cancel (the only claim-release path)
 * was dead. The fix: resolver UPDATEs the existing attempt row in place;
 * cancel numbers its audit row MAX(attempt_no)+1 (collision-free because
 * `cancelado` is terminal). These tests fail on the pre-fix code.
 */
describe('LivroFinanceiroRepositoryPostgres — transfer FSM audit rows (aperture-vvh2j)', () => {
  let repo: LivroFinanceiroRepositoryPostgres;

  beforeEach(async () => {
    // aperture-477nz — candidatos FK-references repasses_recebedor; child first.
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('repasse_reconciliacao_candidatos').execute();
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('repasse_transfer_attempts').execute();
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('lancamentos_financeiros').execute();
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('repasses_recebedor').execute();
    repo = withLancamentoSeeding(new LivroFinanceiroRepositoryPostgres(testDb.db), testDb.db);
  });

  // Walk solicitado → aprovado(pix) → transferindo → verificando, with one
  // linked lançamento claimed by the repasse. Mirrors the real executar path.
  async function seedVerificando(): Promise<{
    idRepasse: IdRepasse;
    idPagamento: IdPagamentoReferencia;
    idLancamento: IdLancamentoFinanceiro;
  }> {
    const idCampanha = randomUUID() as IdCampanha;
    const repasse = makeRepasse({ idCampanha, amountCents: 5000, status: 'solicitado' });
    await repo.saveRepasse(repasse);

    const lancamento = makeLancamentoRecebedor({
      idCampanha,
      amountCents: 5000,
      idRepasse: repasse.id,
    });
    await repo.saveLancamentos([lancamento]);

    const referencia = `EN${String(repasse.id).replace(/-/g, '')}`;
    await repo.aprovarRepassePixTransaction(
      {
        idRepasse: repasse.id,
        aprovadoEm: new Date('2026-07-16T12:00:00Z'),
        transferReferencia: referencia,
      },
      // no-op enqueue — the transactional job seam is covered elsewhere.
      async () => {},
    );

    const ini = await repo.iniciarTransferenciaTransaction({
      idRepasse: repasse.id,
      requestSummary: 'pagarPix valor=5000',
      agora: new Date('2026-07-16T12:00:01Z'),
    });
    expect(ini.acao).toBe('prosseguir');
    expect(ini.attemptNo).toBe(1);

    await repo.finalizarTentativaTransferencia({
      idRepasse: repasse.id,
      attemptId: ini.attemptId,
      resultado: { tipo: 'verificando', codigoSolicitacao: null },
      agora: new Date('2026-07-16T12:00:02Z'),
    });

    return {
      idRepasse: repasse.id,
      idPagamento: lancamento.idPagamento,
      idLancamento: lancamento.id,
    };
  }

  it('resolverVerificacaoTransferencia(pago) — closes the attempt row in place (no 23505), books the debit', async () => {
    const { idRepasse, idPagamento } = await seedVerificando();

    await expect(
      repo.resolverVerificacaoTransferencia({
        idRepasse,
        resultado: { tipo: 'pago', codigoSolicitacao: 'inter_fake_pago' },
        reconciliacaoResumo: 'consulta:pago',
        agora: new Date('2026-07-16T12:05:00Z'),
      }),
    ).resolves.not.toThrow();

    const repasse = await repo.findRepasseById(idRepasse);
    expect(repasse?.status).toBe('pago');
    expect(repasse?.interCodigoSolicitacao).toBe('inter_fake_pago');

    // transferido_em stamped — the single §10.1 debit point.
    const [linked] = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(linked?.transferidoEm).not.toBeNull();

    // Exactly ONE attempt row — the intent row, closed to pago (not a 2nd row).
    const attempts = await repo.findTransferAttemptsByRepasseId(idRepasse);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attemptNo).toBe(1);
    expect(attempts[0]?.outcome).toBe('pago');
    expect(attempts[0]?.codigoSolicitacao).toBe('inter_fake_pago');
  });

  it('resolverVerificacaoTransferencia(falhou) — closes the attempt row in place (no 23505), no debit', async () => {
    const { idRepasse, idPagamento } = await seedVerificando();

    await expect(
      repo.resolverVerificacaoTransferencia({
        idRepasse,
        resultado: { tipo: 'falhou', erro: 'NAO_ENCONTRADO_NA_BUSCA' },
        reconciliacaoResumo: 'busca:sem_match;janela_esgotada',
        agora: new Date('2026-07-16T12:05:00Z'),
      }),
    ).resolves.not.toThrow();

    const repasse = await repo.findRepasseById(idRepasse);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('NAO_ENCONTRADO_NA_BUSCA');

    // Money never moved — transferido_em stays null.
    const [linked] = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(linked?.transferidoEm).toBeNull();

    const attempts = await repo.findTransferAttemptsByRepasseId(idRepasse);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('falhou');
  });

  it('cancelarRepasseTransaction — releases the claim + writes a MAX+1 audit row (no 23505)', async () => {
    const { idRepasse, idPagamento } = await seedVerificando();
    // Cancel is only valid from falhou — drive verificando → falhou first.
    await repo.resolverVerificacaoTransferencia({
      idRepasse,
      resultado: { tipo: 'falhou', erro: 'NAO_ENCONTRADO_NA_BUSCA' },
      reconciliacaoResumo: 'busca:sem_match;janela_esgotada',
      agora: new Date('2026-07-16T12:05:00Z'),
    });

    const result = await repo.cancelarRepasseTransaction({
      idRepasse,
      canceladoPor: 'admin@eunenem.com',
      agora: new Date('2026-07-16T12:10:00Z'),
    });
    expect(result.repasse.status).toBe('cancelado');
    expect(result.lancamentosLiberados).toBe(1);

    // The claim is released — id_repasse cleared, funds return to disponivel.
    const [linked] = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(linked?.idRepasse).toBeNull();

    // Two audit rows: closed intent (attempt_no=1) + cancel event (MAX+1=2).
    // The pre-fix code reused attempt_no=1 for the cancel row → 23505.
    const attempts = await repo.findTransferAttemptsByRepasseId(idRepasse);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
    const cancelRow = attempts.find((a) => a.outcome === 'cancelado');
    expect(cancelRow?.attemptNo).toBe(2);
    expect(cancelRow?.requestSummary).toContain('cancelado_por:admin@eunenem.com');
  });

  it('retry after falhou increments attempt_no monotonically with no collision', async () => {
    const { idRepasse } = await seedVerificando();
    await repo.resolverVerificacaoTransferencia({
      idRepasse,
      resultado: { tipo: 'falhou', erro: 'CONSULTA_REJEITADO' },
      reconciliacaoResumo: 'consulta:rejeitado',
      agora: new Date('2026-07-16T12:05:00Z'),
    });

    // Admin retry → fresh claim, attempt_no increments to 2, new intent row.
    const ini2 = await repo.iniciarTransferenciaTransaction({
      idRepasse,
      requestSummary: 'pagarPix valor=5000 (retry)',
      agora: new Date('2026-07-16T12:06:00Z'),
    });
    expect(ini2.acao).toBe('prosseguir');
    expect(ini2.attemptNo).toBe(2);

    const attempts = await repo.findTransferAttemptsByRepasseId(idRepasse);
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  aperture-477nz — manual-resolution FSM (pg-backed)
//
//  The never-auto-pago reconciliation path. A search match cannot PROVE it's
//  ours (Inter has no reliable caller-supplied identifier), so it flags
//  needs-manual-resolution and persists masked candidates; an admin then
//  resolves to pago (booking identically to auto-pago) or falhou. Plus the
//  DISARM BOUNDARY: zero-candidate window exhaustion routes to needs-manual
//  (flag OFF) or auto-falhou (flag ON) — verified end-to-end against real SQL.
// ─────────────────────────────────────────────────────────────────────
describe('LivroFinanceiroRepositoryPostgres — manual resolution (aperture-477nz)', () => {
  let repo: LivroFinanceiroRepositoryPostgres;

  beforeEach(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('repasse_reconciliacao_candidatos').execute();
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('repasse_transfer_attempts').execute();
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('lancamentos_financeiros').execute();
    // biome-ignore lint/suspicious/noExplicitAny: tables not yet in generated types
    await (testDb.db as any).deleteFrom('repasses_recebedor').execute();
    repo = withLancamentoSeeding(new LivroFinanceiroRepositoryPostgres(testDb.db), testDb.db);
  });

  async function seedVerificando(): Promise<{
    idRepasse: IdRepasse;
    idCampanha: IdCampanha;
    idPagamento: IdPagamentoReferencia;
  }> {
    const idCampanha = randomUUID() as IdCampanha;
    const repasse = makeRepasse({ idCampanha, amountCents: 5000, status: 'solicitado' });
    await repo.saveRepasse(repasse);
    const lancamento = makeLancamentoRecebedor({
      idCampanha,
      amountCents: 5000,
      idRepasse: repasse.id,
    });
    await repo.saveLancamentos([lancamento]);
    await repo.aprovarRepassePixTransaction(
      {
        idRepasse: repasse.id,
        aprovadoEm: new Date('2026-07-16T12:00:00Z'),
        transferReferencia: `EN${String(repasse.id).replace(/-/g, '')}`,
      },
      async () => {},
    );
    const ini = await repo.iniciarTransferenciaTransaction({
      idRepasse: repasse.id,
      requestSummary: 'pagarPix valor=5000',
      agora: new Date('2026-07-16T12:00:01Z'),
    });
    await repo.finalizarTentativaTransferencia({
      idRepasse: repasse.id,
      attemptId: ini.attemptId,
      resultado: { tipo: 'verificando', codigoSolicitacao: null },
      agora: new Date('2026-07-16T12:00:02Z'),
    });
    return { idRepasse: repasse.id, idCampanha, idPagamento: lancamento.idPagamento };
  }

  const CANDIDATO = {
    codigoSolicitacao: 'inter_manual_codigo_xyz',
    valorCents: 5000,
    dataMovimento: '2026-07-16',
    chaveMascarada: 'b***om', // bia@example.com masked — the full chave never at rest
    descricaoPix: null,
  } as const;

  it('flagNeedsManualResolutionTransaction — stays verificando, sets the flag, persists masked candidates (idempotent)', async () => {
    const { idRepasse } = await seedVerificando();

    await repo.flagNeedsManualResolutionTransaction({
      idRepasse,
      candidatos: [CANDIDATO],
      agora: new Date('2026-07-16T12:05:00Z'),
    });
    // Idempotent on (repasse_id, codigo_solicitacao) — a duplicate flag does
    // not create a second candidate row.
    await repo.flagNeedsManualResolutionTransaction({
      idRepasse,
      candidatos: [CANDIDATO],
      agora: new Date('2026-07-16T12:06:00Z'),
    });

    const repasse = await repo.findRepasseById(idRepasse);
    expect(repasse?.status).toBe('verificando');
    expect(repasse?.needsManualResolution).toBe(true);

    const candidatos = await repo.findCandidatosByRepasseId(idRepasse);
    expect(candidatos).toHaveLength(1);
    expect(candidatos[0]?.codigoSolicitacao).toBe(CANDIDATO.codigoSolicitacao);
    expect(candidatos[0]?.valorCents).toBe(5000);
    expect(candidatos[0]?.dataMovimento).toBe('2026-07-16');
    expect(candidatos[0]?.chaveMascarada).toBe('b***om');
    // No full chave at rest.
    expect(candidatos[0]?.chaveMascarada).not.toContain('@');
  });

  it('resolverManualPagoTransaction — books identically to auto-pago (records codigo, stamps transferido_em, MAX+1 audit row, clears flag)', async () => {
    const { idRepasse, idPagamento } = await seedVerificando();
    await repo.flagNeedsManualResolutionTransaction({
      idRepasse,
      candidatos: [CANDIDATO],
      agora: new Date('2026-07-16T12:05:00Z'),
    });

    const result = await repo.resolverManualPagoTransaction({
      idRepasse,
      interCodigoSolicitacao: CANDIDATO.codigoSolicitacao,
      resolvidoPor: 'admin@eunenem.com',
      agora: new Date('2026-07-16T12:10:00Z'),
    });
    expect(result.repasse.status).toBe('pago');
    expect(result.repasse.interCodigoSolicitacao).toBe(CANDIDATO.codigoSolicitacao);
    expect(result.repasse.needsManualResolution).toBe(false);

    // §10.1 single debit point — stamped exactly like the auto-pago path.
    const [linked] = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(linked?.transferidoEm).not.toBeNull();

    // Audit: closed intent (attempt_no=1) + manual-pago event (MAX+1=2).
    const attempts = await repo.findTransferAttemptsByRepasseId(idRepasse);
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
    const manualRow = attempts.find((a) => a.attemptNo === 2);
    expect(manualRow?.outcome).toBe('pago');
    expect(manualRow?.codigoSolicitacao).toBe(CANDIDATO.codigoSolicitacao);
    expect(manualRow?.requestSummary).toContain('resolucao_manual_pago_por:admin@eunenem.com');
  });

  it('resolverManualPagoTransaction — idempotent no-op on a non-flagged repasse (never books an unflagged verificando)', async () => {
    const { idRepasse, idPagamento } = await seedVerificando();
    // NOT flagged. A manual-pago must not fire — the repasse is still under
    // automated reconciliation, so booking here could double-pay.
    const result = await repo.resolverManualPagoTransaction({
      idRepasse,
      interCodigoSolicitacao: CANDIDATO.codigoSolicitacao,
      resolvidoPor: 'admin@eunenem.com',
      agora: new Date('2026-07-16T12:10:00Z'),
    });
    expect(result.repasse.status).toBe('verificando'); // unchanged
    const [linked] = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(linked?.transferidoEm).toBeNull(); // no debit
  });

  it('resolverManualFalhouTransaction — falhou, no debit, MAX+1 audit row, clears flag', async () => {
    const { idRepasse, idPagamento } = await seedVerificando();
    await repo.flagNeedsManualResolutionTransaction({
      idRepasse,
      candidatos: [],
      agora: new Date('2026-07-16T12:05:00Z'),
    });

    const result = await repo.resolverManualFalhouTransaction({
      idRepasse,
      erro: 'RESOLUCAO_MANUAL_FALHOU',
      resolvidoPor: 'admin@eunenem.com',
      agora: new Date('2026-07-16T12:10:00Z'),
    });
    expect(result.repasse.status).toBe('falhou');
    expect(result.repasse.needsManualResolution).toBe(false);

    const [linked] = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(linked?.transferidoEm).toBeNull(); // money never moved

    const attempts = await repo.findTransferAttemptsByRepasseId(idRepasse);
    const manualRow = attempts.at(-1);
    expect(manualRow?.outcome).toBe('falhou');
    expect(manualRow?.error).toBe('RESOLUCAO_MANUAL_FALHOU');
    expect(manualRow?.requestSummary).toContain('resolucao_manual_falhou_por:admin@eunenem.com');
  });

  // ── DISARM BOUNDARY end-to-end (confirmar handler → real postgres) ──
  // THE load-bearing transition: at tentativa 12 the ~48h window is exhausted
  // with zero candidates. extratoVerified gates whether that becomes auto-falhou
  // (trusted extrato shape) or needs-manual-resolution (untrusted — a shape
  // mismatch could be hiding a real payment; auto-falhou → retry → double PIX).

  function confirmarDeps(extratoVerified: boolean) {
    return {
      livroFinanceiroRepository: repo,
      transferenciaProvider: new TransferenciaProviderFake({ buscarResultados: [] }),
      repasseJobEnqueuer: {
        async enqueueExecutar() {},
        async enqueueConfirmar() {},
      },
      clock: () => new Date('2026-07-18T12:00:00Z'),
      observability: { logger: new NoopLogger(), tracer: noopTracer() },
      extratoVerified,
    };
  }

  it('DISARMED (extratoVerified=false): zero-candidate exhaustion escalates to needs-manual-resolution in the DB — not falhou', async () => {
    const { idRepasse, idPagamento } = await seedVerificando();

    await confirmarTransferenciaRepasse(confirmarDeps(false), {
      idRepasse,
      tentativaConfirmacao: MAX_TENTATIVAS_CONFIRMACAO,
    });

    const repasse = await repo.findRepasseById(idRepasse);
    expect(repasse?.status).toBe('verificando');
    expect(repasse?.needsManualResolution).toBe(true);
    const [linked] = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(linked?.transferidoEm).toBeNull(); // door stays shut
    const candidatos = await repo.findCandidatosByRepasseId(idRepasse);
    expect(candidatos).toHaveLength(0);
  });

  it('ARMED (extratoVerified=true): zero-candidate exhaustion resolves falhou/NAO_ENCONTRADO_NA_BUSCA in the DB', async () => {
    const { idRepasse, idPagamento } = await seedVerificando();

    await confirmarTransferenciaRepasse(confirmarDeps(true), {
      idRepasse,
      tentativaConfirmacao: MAX_TENTATIVAS_CONFIRMACAO,
    });

    const repasse = await repo.findRepasseById(idRepasse);
    expect(repasse?.status).toBe('falhou');
    expect(repasse?.lastTransferError).toBe('NAO_ENCONTRADO_NA_BUSCA');
    expect(repasse?.needsManualResolution).toBe(false);
    const [linked] = await repo.findLancamentosByIdPagamento(idPagamento);
    expect(linked?.transferidoEm).toBeNull();
  });
});
