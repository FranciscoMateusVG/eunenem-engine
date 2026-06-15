import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { criarContribuicao } from '../../../src/domain/arrecadacao/entities/contribuicao.js';
import {
  type IdCampanha,
  type IdContribuicao,
  type IdOpcaoContribuicao,
} from '../../../src/domain/arrecadacao/value-objects/ids.js';
import {
  criarItemContribuicao,
} from '../../../src/domain/pagamentos/entities/item-do-pagamento.js';
import {
  criarPagamentoPendente,
  type Pagamento,
} from '../../../src/domain/pagamentos/entities/pagamento.js';
import {
  esgotada,
  quantidadeRestante,
} from '../../../src/use-cases/arrecadacao/quantidade-restante.js';
import { createTestObservability } from '../../helpers/observability.js';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2) — quantidadeRestante + esgotada
 * tests. Replaces the pre-0016 contribuicaoEstaIndisponivel.test.ts
 * binary predicate tests with sum-based semantics.
 */

const { observability } = createTestObservability();

function makeRepos() {
  return {
    contribuicaoRepository: new ContribuicaoRepositoryMemory(),
    pagamentoRepository: new PagamentoRepositoryMemory(),
    observability,
  };
}

function makeContribuicao(quantidade: number, idContribuicao?: IdContribuicao) {
  return criarContribuicao({
    id: (idContribuicao ?? randomUUID()) as IdContribuicao,
    idCampanha: randomUUID() as IdCampanha,
    idOpcaoContribuicao: randomUUID() as IdOpcaoContribuicao,
    nome: 'Taça',
    valor: 100 as never,
    quantidade,
    criadaEm: new Date('2026-06-08T12:00:00Z'),
  });
}

function makeAprovadoPagamento(idContribuicao: string, quantidade: number): Pagamento {
  const item = criarItemContribuicao({
    id: randomUUID() as never,
    composicaoValoresItem: {
      tipo: 'contribuicao',
      idContribuicao: idContribuicao as never,
      quantidade,
      contributionUnitAmountCents: 100 as never,
      feeUnitAmountCents: 10 as never,
      receiverUnitAmountCents: 100 as never,
      lineContributionAmountCents: (100 * quantidade) as never,
      lineFeeAmountCents: (10 * quantidade) as never,
      lineReceiverAmountCents: (100 * quantidade) as never,
    },
    criadoEm: new Date(),
  });
  const base = criarPagamentoPendente({
    idPagamento: randomUUID() as never,
    idIntencaoPagamento: randomUUID() as never,
    items: [item],
    composicaoValoresAggregate: {
      idCampanha: randomUUID() as never,
      totalContributionCents: (100 * quantidade) as never,
      totalFeeCents: (10 * quantidade) as never,
      totalReceiverCents: (100 * quantidade) as never,
      totalSurchargeCents: 0,
      totalPaidCents: (110 * quantidade) as never,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: (110 * quantidade) as never,
    metodo: 'pix',
    criadoEm: new Date(),
  });
  return { ...base, status: 'aprovado' as const };
}

describe('quantidadeRestante', () => {
  it('retorna null quando a contribuição não existe', async () => {
    const deps = makeRepos();
    const result = await quantidadeRestante(deps, { idContribuicao: randomUUID() as IdContribuicao });
    expect(result).toBeNull();
  });

  it('retorna quantidade integral quando não há pagamentos aprovados', async () => {
    const deps = makeRepos();
    const contribuicao = makeContribuicao(5);
    await deps.contribuicaoRepository.save(contribuicao);

    const result = await quantidadeRestante(deps, { idContribuicao: contribuicao.id });
    expect(result).toBe(5);
  });

  it('subtrai a soma de quantidades dos items aprovados', async () => {
    const deps = makeRepos();
    const contribuicao = makeContribuicao(5);
    await deps.contribuicaoRepository.save(contribuicao);

    await deps.pagamentoRepository.save(makeAprovadoPagamento(contribuicao.id, 2));
    await deps.pagamentoRepository.save(makeAprovadoPagamento(contribuicao.id, 1));

    const result = await quantidadeRestante(deps, { idContribuicao: contribuicao.id });
    expect(result).toBe(5 - 3);
  });

  it('aceita overshoot (resultado negativo) per locked decision #10', async () => {
    const deps = makeRepos();
    const contribuicao = makeContribuicao(2);
    await deps.contribuicaoRepository.save(contribuicao);

    await deps.pagamentoRepository.save(makeAprovadoPagamento(contribuicao.id, 3));

    const result = await quantidadeRestante(deps, { idContribuicao: contribuicao.id });
    expect(result).toBe(-1);
  });
});

describe('esgotada', () => {
  it('retorna false quando a contribuição não existe', async () => {
    const deps = makeRepos();
    const result = await esgotada(deps, { idContribuicao: randomUUID() as IdContribuicao });
    expect(result).toBe(false);
  });

  it('retorna false quando quantidadeRestante > 0', async () => {
    const deps = makeRepos();
    const contribuicao = makeContribuicao(3);
    await deps.contribuicaoRepository.save(contribuicao);

    await deps.pagamentoRepository.save(makeAprovadoPagamento(contribuicao.id, 1));

    const result = await esgotada(deps, { idContribuicao: contribuicao.id });
    expect(result).toBe(false);
  });

  it('retorna true quando quantidadeRestante === 0', async () => {
    const deps = makeRepos();
    const contribuicao = makeContribuicao(2);
    await deps.contribuicaoRepository.save(contribuicao);

    await deps.pagamentoRepository.save(makeAprovadoPagamento(contribuicao.id, 2));

    const result = await esgotada(deps, { idContribuicao: contribuicao.id });
    expect(result).toBe(true);
  });

  it('retorna true quando quantidadeRestante < 0 (overshoot)', async () => {
    const deps = makeRepos();
    const contribuicao = makeContribuicao(2);
    await deps.contribuicaoRepository.save(contribuicao);

    await deps.pagamentoRepository.save(makeAprovadoPagamento(contribuicao.id, 3));

    const result = await esgotada(deps, { idContribuicao: contribuicao.id });
    expect(result).toBe(true);
  });
});
