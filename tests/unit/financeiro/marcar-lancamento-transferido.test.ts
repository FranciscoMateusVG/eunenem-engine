import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import type { Pagamento } from '../../../src/domain/pagamentos/entities/pagamento.js';
import type { LancamentoFinanceiro } from '../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import { FinanceiroInputInvalidoError } from '../../../src/errors/pagamentos/financeiro/input-invalido.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import {
  MarcarLancamentoTransferidoBloqueadoError,
  marcarLancamentoTransferido,
} from '../../../src/use-cases/pagamentos/financeiro/marcar-lancamento-transferido.js';

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

/**
 * Seed a "disponível" pagamento (status='aprovado', availableOn <=
 * clock). The plan-0015 gate requires this for the use-case to proceed;
 * tests that exercise the happy path / idempotency seed this shape.
 */
async function seedDisponivelPagamento(
  pagamentoRepository: PagamentoRepositoryMemory,
  overrides: { id?: string; availableOn?: Date | null } = {},
): Promise<void> {
  const pagamento: Pagamento = {
    id: (overrides.id ?? idPagamento) as never,
    status: 'aprovado',
    criadoEm: new Date('2026-05-01T12:00:00Z'),
    atualizadoEm: new Date('2026-05-01T12:00:00Z'),
    intencao: {
      id: '550e8400-e29b-41d4-a716-446655440414' as never,
      idContribuicao: idContribuicao as never,
      amountCents: 1000 as never,
      metodo: 'pix',
      composicaoValores: {
        idContribuicao,
        contributionAmountCents: 1000 as never,
        feeAmountCents: 0 as never,
        surchargeCents: 0 as never,
        totalPaidCents: 1000 as never,
        receiverAmountCents: 1000 as never,
        responsavelTaxa: 'contribuinte',
      } as never,
      externalRef: null,
      paymentIntentExternalRef: null,
      chargeExternalRef: null,
      contribuinte: null,
      balanceTransactionAvailableOn:
        overrides.availableOn === undefined
          ? new Date('2026-05-02T10:00:00Z') // <= test clock 2026-05-10
          : overrides.availableOn,
      criadaEm: new Date('2026-05-01T12:00:00Z'),
    },
  };
  await pagamentoRepository.save(pagamento);
}

describe('marcarLancamentoTransferido — happy path (disponível pagamento)', () => {
  it('stamps transferidoEm on all pending IDs in the batch', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const pagamentoRepository = new PagamentoRepositoryMemory();
    await seedDisponivelPagamento(pagamentoRepository);
    await livro.saveLancamentos([row(idLancA), row(idLancB)]);

    const result = await marcarLancamentoTransferido(
      {
        livroFinanceiroRepository: livro,
        pagamentoRepository,
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
    const pagamentoRepository = new PagamentoRepositoryMemory();
    await seedDisponivelPagamento(pagamentoRepository);
    const alreadyTransferred = row(idLancA, {
      transferidoEm: new Date('2026-05-09T10:00:00Z'),
    });
    await livro.saveLancamentos([alreadyTransferred, row(idLancB)]);

    const result = await marcarLancamentoTransferido(
      {
        livroFinanceiroRepository: livro,
        pagamentoRepository,
        clock: () => new Date('2026-05-10T10:00:00Z'),
        observability,
      },
      { idsLancamentos: [idLancA, idLancB] },
    );

    expect(result.transferidoEm).toEqual(new Date('2026-05-10T10:00:00Z'));
    const after = await livro.findLancamentosByIdPagamento(idPagamento);
    const a = after.find((l) => l.id === idLancA);
    const b = after.find((l) => l.id === idLancB);
    expect(a?.transferidoEm).toEqual(new Date('2026-05-09T10:00:00Z'));
    expect(b?.transferidoEm).toEqual(new Date('2026-05-10T10:00:00Z'));
  });

  it('skips cancelled rows (cancelled money never reached the recebedor)', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const pagamentoRepository = new PagamentoRepositoryMemory();
    await seedDisponivelPagamento(pagamentoRepository);
    const cancelled = row(idLancC, {
      canceladoEm: new Date('2026-05-08T10:00:00Z'),
    });
    await livro.saveLancamentos([row(idLancA), cancelled]);

    await marcarLancamentoTransferido(
      {
        livroFinanceiroRepository: livro,
        pagamentoRepository,
        clock: () => new Date('2026-05-10T10:00:00Z'),
        observability,
      },
      { idsLancamentos: [idLancA, idLancC] },
    );

    const after = await livro.findLancamentosByIdPagamento(idPagamento);
    const a = after.find((l) => l.id === idLancA);
    const c = after.find((l) => l.id === idLancC);
    expect(a?.transferidoEm).toEqual(new Date('2026-05-10T10:00:00Z'));
    expect(c?.transferidoEm).toBeNull();
    expect(c?.canceladoEm).toEqual(new Date('2026-05-08T10:00:00Z'));
  });
});

describe('marcarLancamentoTransferido — input validation', () => {
  it('rejects empty batch', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const pagamentoRepository = new PagamentoRepositoryMemory();
    await expect(
      marcarLancamentoTransferido(
        {
          livroFinanceiroRepository: livro,
          pagamentoRepository,
          clock: () => new Date(),
          observability,
        },
        { idsLancamentos: [] },
      ),
    ).rejects.toBeInstanceOf(FinanceiroInputInvalidoError);
  });
});

// ────────────────────────────────────────────────────────────────────
//  Plan 0015 derived-liberação gate (aperture-mjgxe)
// ────────────────────────────────────────────────────────────────────

describe('marcarLancamentoTransferido — derived-liberação gate (aperture-mjgxe)', () => {
  it('refuses when pagamento is not yet aprovado', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const pagamentoRepository = new PagamentoRepositoryMemory();
    // Seed pendente (not aprovado).
    const pagamento: Pagamento = {
      id: idPagamento as never,
      status: 'pendente',
      criadoEm: new Date('2026-05-01T12:00:00Z'),
      atualizadoEm: new Date('2026-05-01T12:00:00Z'),
      intencao: {
        id: '550e8400-e29b-41d4-a716-446655440499' as never,
        idContribuicao: idContribuicao as never,
        amountCents: 1000 as never,
        metodo: 'pix',
        composicaoValores: {
          idContribuicao,
          contributionAmountCents: 1000 as never,
          feeAmountCents: 0 as never,
          surchargeCents: 0 as never,
          totalPaidCents: 1000 as never,
          receiverAmountCents: 1000 as never,
          responsavelTaxa: 'contribuinte',
        } as never,
        externalRef: null,
        paymentIntentExternalRef: null,
        chargeExternalRef: null,
        contribuinte: null,
        balanceTransactionAvailableOn: null,
        criadaEm: new Date('2026-05-01T12:00:00Z'),
      },
    };
    await pagamentoRepository.save(pagamento);
    await livro.saveLancamentos([row(idLancA)]);

    await expect(
      marcarLancamentoTransferido(
        {
          livroFinanceiroRepository: livro,
          pagamentoRepository,
          clock: () => new Date('2026-05-10T10:00:00Z'),
          observability,
        },
        { idsLancamentos: [idLancA] },
      ),
    ).rejects.toMatchObject({
      name: 'MarcarLancamentoTransferidoBloqueadoError',
      reason: 'pagamento_nao_aprovado',
    });

    // No transferidoEm stamped (gate fired before update).
    const after = await livro.findLancamentosByIdPagamento(idPagamento);
    expect(after[0].transferidoEm).toBeNull();
  });

  it('refuses when aprovado AND availableOn is null (defensive)', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const pagamentoRepository = new PagamentoRepositoryMemory();
    await seedDisponivelPagamento(pagamentoRepository, { availableOn: null });
    await livro.saveLancamentos([row(idLancA)]);

    await expect(
      marcarLancamentoTransferido(
        {
          livroFinanceiroRepository: livro,
          pagamentoRepository,
          clock: () => new Date('2026-05-10T10:00:00Z'),
          observability,
        },
        { idsLancamentos: [idLancA] },
      ),
    ).rejects.toMatchObject({
      name: 'MarcarLancamentoTransferidoBloqueadoError',
      reason: 'aguardando_liberacao_sem_data',
    });
  });

  it('refuses when availableOn is in the future (aguardando)', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const pagamentoRepository = new PagamentoRepositoryMemory();
    await seedDisponivelPagamento(pagamentoRepository, {
      availableOn: new Date('2026-06-15T10:00:00Z'), // future relative to clock 2026-05-10
    });
    await livro.saveLancamentos([row(idLancA)]);

    await expect(
      marcarLancamentoTransferido(
        {
          livroFinanceiroRepository: livro,
          pagamentoRepository,
          clock: () => new Date('2026-05-10T10:00:00Z'),
          observability,
        },
        { idsLancamentos: [idLancA] },
      ),
    ).rejects.toMatchObject({
      name: 'MarcarLancamentoTransferidoBloqueadoError',
      reason: 'aguardando_liberacao_ate',
      availableOn: new Date('2026-06-15T10:00:00Z'),
    });
  });

  it('refuses the WHOLE batch if ANY single pagamento fails the gate', async () => {
    const livro = new LivroFinanceiroRepositoryMemory();
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const idOtherPagamento = '550e8400-e29b-41d4-a716-446655440499';
    // pagamento A is disponível
    await seedDisponivelPagamento(pagamentoRepository);
    // pagamento B is aguardando-liberação (future date)
    await seedDisponivelPagamento(pagamentoRepository, {
      id: idOtherPagamento,
      availableOn: new Date('2026-06-15T10:00:00Z'),
    });
    // lançamento A under pagamento A; lançamento B under pagamento B
    await livro.saveLancamentos([row(idLancA), row(idLancB, { idPagamento: idOtherPagamento })]);

    await expect(
      marcarLancamentoTransferido(
        {
          livroFinanceiroRepository: livro,
          pagamentoRepository,
          clock: () => new Date('2026-05-10T10:00:00Z'),
          observability,
        },
        { idsLancamentos: [idLancA, idLancB] },
      ),
    ).rejects.toBeInstanceOf(MarcarLancamentoTransferidoBloqueadoError);

    // Neither lançamento was stamped — atomicity preserved.
    const afterA = await livro.findLancamentosByIdPagamento(idPagamento);
    const afterB = await livro.findLancamentosByIdPagamento(idOtherPagamento);
    expect(afterA[0].transferidoEm).toBeNull();
    expect(afterB[0].transferidoEm).toBeNull();
  });
});
