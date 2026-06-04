import { describe, expect, it } from 'vitest';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import {
  aprovarPagamentoPendente,
  criarPagamentoPendente,
  rejeitarPagamentoPendente,
} from '../../../src/domain/pagamentos/entities/pagamento.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { contribuicaoEstaIndisponivel } from '../../../src/use-cases/arrecadacao/contribuicao-esta-indisponivel.js';

const observability = { logger: new NoopLogger(), tracer: noopTracer() };

const idContribuicao = '550e8400-e29b-41d4-a716-446655440501';
const idPagamento = '550e8400-e29b-41d4-a716-446655440502';
const idIntencao = '550e8400-e29b-41d4-a716-446655440503';
const idTransacao = '550e8400-e29b-41d4-a716-446655440504';
const criadoEm = new Date('2026-05-01T12:00:00Z');

const composicaoValores = {
  idContribuicao,
  contributionAmountCents: 8000,
  feeAmountCents: 400,
  totalPaidCents: 8400,
  receiverAmountCents: 8000,
  responsavelTaxa: 'contribuinte' as const,
};

describe('contribuicaoEstaIndisponivel', () => {
  it('returns false when no pagamentos exist for the contribuição', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const result = await contribuicaoEstaIndisponivel(
      { pagamentoRepository, observability },
      { idContribuicao },
    );
    expect(result).toBe(false);
  });

  it('returns false when only pendente pagamentos exist (no aprovado yet)', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    await pagamentoRepository.save(
      criarPagamentoPendente({
        idPagamento,
        idIntencaoPagamento: idIntencao,
        composicaoValores,
        valorACobrarCents: 8400,
        metodo: 'pix',
        criadoEm,
      }),
    );
    const result = await contribuicaoEstaIndisponivel(
      { pagamentoRepository, observability },
      { idContribuicao },
    );
    expect(result).toBe(false);
  });

  it('returns false when only rejeitado pagamentos exist', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const pendente = criarPagamentoPendente({
      idPagamento,
      idIntencaoPagamento: idIntencao,
      composicaoValores,
      valorACobrarCents: 8400,
      metodo: 'pix',
      criadoEm,
    });
    const rejeitado = rejeitarPagamentoPendente(
      pendente,
      {
        id: idTransacao,
        provedor: 'fake-provider',
        status: 'rejeitado',
        amountCents: 8400,
        criadaEm: criadoEm,
      },
      criadoEm,
    );
    await pagamentoRepository.save(rejeitado);

    const result = await contribuicaoEstaIndisponivel(
      { pagamentoRepository, observability },
      { idContribuicao },
    );
    expect(result).toBe(false);
  });

  it('returns true when at least one aprovado pagamento exists', async () => {
    const pagamentoRepository = new PagamentoRepositoryMemory();
    const pendente = criarPagamentoPendente({
      idPagamento,
      idIntencaoPagamento: idIntencao,
      composicaoValores,
      valorACobrarCents: 8400,
      metodo: 'pix',
      criadoEm,
    });
    const aprovado = aprovarPagamentoPendente(
      pendente,
      {
        id: idTransacao,
        provedor: 'fake-provider',
        status: 'aprovado',
        amountCents: 8400,
        criadaEm: criadoEm,
      },
      criadoEm,
    );
    await pagamentoRepository.save(aprovado);

    const result = await contribuicaoEstaIndisponivel(
      { pagamentoRepository, observability },
      { idContribuicao },
    );
    expect(result).toBe(true);
  });
});
