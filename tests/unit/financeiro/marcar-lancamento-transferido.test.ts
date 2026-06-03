import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/financeiro/livro-repository.memory.js';
import type { LancamentoFinanceiro } from '../../../src/domain/financeiro/entities/lancamento-financeiro.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { marcarLancamentoTransferido } from '../../../src/use-cases/financeiro/marcar-lancamento-transferido.js';
import { FinanceiroInputInvalidoError } from '../../../src/errors/financeiro/input-invalido.error.js';

const observability = { logger: new NoopLogger(), tracer: noopTracer() };

const idLancA = '550e8400-e29b-41d4-a716-446655440401';
const idLancB = '550e8400-e29b-41d4-a716-446655440402';
const idLancC = '550e8400-e29b-41d4-a716-446655440403';
const idPagamento = '550e8400-e29b-41d4-a716-446655440404';
const idContribuicao = '550e8400-e29b-41d4-a716-446655440405';

function row(id: string, overrides: Partial<LancamentoFinanceiro> = {}): LancamentoFinanceiro {
  return {
    id,
    idPagamento,
    idContribuicao,
    tipo: 'credito_saldo_recebedor',
    amountCents: 1000,
    criadoEm: new Date('2026-05-01T12:00:00Z'),
    transferidoEm: null,
    canceladoEm: null,
    ...overrides,
  };
}

describe('marcarLancamentoTransferido — happy path', () => {
  it('stamps transferidoEm on all pending IDs in the batch', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    await livro.saveLancamentos([row(idLancA), row(idLancB)]);

    const result = await marcarLancamentoTransferido(
      {
        livroFinanceiroRepository: livro,
        clock: () => new Date('2026-05-10T10:00:00Z'),
        observability,
      },
      { idsLancamentos: [idLancA, idLancB] },
    );

    expect(result.transferidoEm).toEqual(new Date('2026-05-10T10:00:00Z'));
    const after = await livro.findLancamentosByIdPagamento(idPagamento);
    for (const l of after) {
      expect(l.transferidoEm).toEqual(new Date('2026-05-10T10:00:00Z'));
      expect(l.canceladoEm).toBeNull();
    }
  });
});

describe('marcarLancamentoTransferido — idempotency', () => {
  it('re-marking already-transferred rows is a silent no-op', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const alreadyTransferred = row(idLancA, {
      transferidoEm: new Date('2026-05-09T10:00:00Z'),
    });
    await livro.saveLancamentos([alreadyTransferred, row(idLancB)]);

    // Mix already-transferred + fresh ID. The use-case re-fires
    // without error; only idLancB gets the new timestamp.
    const result = await marcarLancamentoTransferido(
      {
        livroFinanceiroRepository: livro,
        clock: () => new Date('2026-05-10T10:00:00Z'),
        observability,
      },
      { idsLancamentos: [idLancA, idLancB] },
    );

    expect(result.transferidoEm).toEqual(new Date('2026-05-10T10:00:00Z'));
    const after = await livro.findLancamentosByIdPagamento(idPagamento);
    const a = after.find((l) => l.id === idLancA);
    const b = after.find((l) => l.id === idLancB);
    // A's original timestamp preserved (idempotent skip).
    expect(a?.transferidoEm).toEqual(new Date('2026-05-09T10:00:00Z'));
    // B picked up the new timestamp.
    expect(b?.transferidoEm).toEqual(new Date('2026-05-10T10:00:00Z'));
  });

  it('skips cancelled rows (cancelled money never reached the recebedor)', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const cancelled = row(idLancC, {
      canceladoEm: new Date('2026-05-08T10:00:00Z'),
    });
    await livro.saveLancamentos([row(idLancA), cancelled]);

    await marcarLancamentoTransferido(
      {
        livroFinanceiroRepository: livro,
        clock: () => new Date('2026-05-10T10:00:00Z'),
        observability,
      },
      { idsLancamentos: [idLancA, idLancC] },
    );

    const after = await livro.findLancamentosByIdPagamento(idPagamento);
    const a = after.find((l) => l.id === idLancA);
    const c = after.find((l) => l.id === idLancC);
    // A transferred normally.
    expect(a?.transferidoEm).toEqual(new Date('2026-05-10T10:00:00Z'));
    // C stays cancelled, NOT transferred (the adapter WHERE skips it).
    expect(c?.transferidoEm).toBeNull();
    expect(c?.canceladoEm).toEqual(new Date('2026-05-08T10:00:00Z'));
  });
});

describe('marcarLancamentoTransferido — input validation', () => {
  it('rejects empty batch', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    await expect(
      marcarLancamentoTransferido(
        {
          livroFinanceiroRepository: livro,
          clock: () => new Date(),
          observability,
        },
        { idsLancamentos: [] },
      ),
    ).rejects.toBeInstanceOf(FinanceiroInputInvalidoError);
  });
});
