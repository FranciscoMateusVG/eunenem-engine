import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/financeiro/livro-repository.memory.js';
import type { LancamentoFinanceiro } from '../../../src/domain/financeiro/entities/lancamento-financeiro.js';
import type {
  IdContribuicaoReferencia,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
} from '../../../src/domain/financeiro/value-objects/ids.js';
import type { IdCampanha } from '../../../src/domain/arrecadacao/value-objects/ids.js';
import { maturarLancamentosPendentes } from '../../../src/use-cases/financeiro/maturar-lancamentos-pendentes.js';
import { createTestObservability } from '../../helpers/observability.js';

/**
 * Tests for aperture-led0r — maturarLancamentosPendentes use-case +
 * findPendentesMaturos port conformance (memory adapter).
 *
 * Bead acceptance criteria (d) + (e):
 *   - 0 maturos: returns count 0, flips nothing
 *   - With maturos: flips status to disponivel, idempotent on re-run,
 *     returns flipped ids
 *   - Boundary: maturaEm exactly = now is considered matured
 *   - findPendentesMaturos excludes disponivel rows even with past
 *     maturaEm; excludes pendente rows with future maturaEm
 */

function makeLancamento(overrides: Partial<LancamentoFinanceiro> = {}): LancamentoFinanceiro {
  const criadoEm = new Date('2026-05-01T12:00:00.000Z');
  return {
    id: randomUUID() as IdLancamentoFinanceiro,
    idPagamento: randomUUID() as IdPagamentoReferencia,
    idContribuicao: randomUUID() as IdContribuicaoReferencia,
    idCampanha: randomUUID() as IdCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents: 1000,
    status: 'pendente',
    criadoEm,
    maturaEm: criadoEm,
    ...overrides,
  };
}

describe('maturarLancamentosPendentes (aperture-led0r)', () => {
  let repo: LivroFinanceiroRepositoryMemory;
  const testObs = createTestObservability();
  const deps = () => ({
    livroFinanceiroRepository: repo,
    observability: testObs.observability,
  });

  beforeEach(() => {
    repo = new LivroFinanceiroRepositoryMemory();
    testObs.reset();
  });

  it('(d) no maturos: returns count=0, flips nothing', async () => {
    // Seed only future-maturing pendente rows.
    await repo.saveLancamentos([
      makeLancamento({ maturaEm: new Date('2026-06-10T00:00:00.000Z') }),
      makeLancamento({ maturaEm: new Date('2026-07-01T00:00:00.000Z') }),
    ]);

    const result = await maturarLancamentosPendentes(deps(), {
      agora: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(result.count).toBe(0);
    expect(result.idsMaturados).toEqual([]);
  });

  it('(d) with maturos: flips status to disponivel and returns flipped ids', async () => {
    const matureRow1 = makeLancamento({
      maturaEm: new Date('2026-05-01T13:00:00.000Z'),
    });
    const matureRow2 = makeLancamento({
      maturaEm: new Date('2026-05-15T00:00:00.000Z'),
    });
    const futureRow = makeLancamento({
      maturaEm: new Date('2026-12-01T00:00:00.000Z'),
    });
    await repo.saveLancamentos([matureRow1, matureRow2, futureRow]);

    const result = await maturarLancamentosPendentes(deps(), {
      agora: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(result.count).toBe(2);
    expect([...result.idsMaturados].sort()).toEqual([matureRow1.id, matureRow2.id].sort());

    // Verify flip persisted.
    const all = await repo.findLancamentosByIdPagamento(matureRow1.idPagamento);
    expect(all[0]?.status).toBe('disponivel');
    const all2 = await repo.findLancamentosByIdPagamento(matureRow2.idPagamento);
    expect(all2[0]?.status).toBe('disponivel');
    const allFuture = await repo.findLancamentosByIdPagamento(futureRow.idPagamento);
    expect(allFuture[0]?.status).toBe('pendente');
  });

  it('(d) idempotent: re-running with same now is a no-op (zero matched)', async () => {
    const matureRow = makeLancamento({ maturaEm: new Date('2026-05-01T13:00:00.000Z') });
    await repo.saveLancamentos([matureRow]);

    const first = await maturarLancamentosPendentes(deps(), {
      agora: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(first.count).toBe(1);

    const second = await maturarLancamentosPendentes(deps(), {
      agora: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(second.count).toBe(0);
    expect(second.idsMaturados).toEqual([]);
  });

  it('(d) boundary: maturaEm exactly === now IS considered matured (≤ semantics)', async () => {
    const exactRow = makeLancamento({
      maturaEm: new Date('2026-06-01T00:00:00.000Z'),
    });
    await repo.saveLancamentos([exactRow]);

    const result = await maturarLancamentosPendentes(deps(), {
      agora: new Date('2026-06-01T00:00:00.000Z'),
    });

    expect(result.count).toBe(1);
    expect(result.idsMaturados).toEqual([exactRow.id]);
  });

  it('(e) findPendentesMaturos excludes disponivel rows even when maturaEm is in the past', async () => {
    // Already-disponivel row with maturaEm long past — must NOT show up.
    const alreadyDisponivelStale = makeLancamento({
      status: 'disponivel',
      maturaEm: new Date('2026-01-01T00:00:00.000Z'),
    });
    // Pendente row with future maturaEm — must NOT show up.
    const pendenteFuture = makeLancamento({
      maturaEm: new Date('2026-12-31T00:00:00.000Z'),
    });
    // Pendente row with past maturaEm — DOES show up.
    const pendentePast = makeLancamento({
      maturaEm: new Date('2026-05-01T00:00:00.000Z'),
    });
    await repo.saveLancamentos([alreadyDisponivelStale, pendenteFuture, pendentePast]);

    const found = await repo.findPendentesMaturos(new Date('2026-06-01T00:00:00.000Z'));

    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(pendentePast.id);
  });
});
