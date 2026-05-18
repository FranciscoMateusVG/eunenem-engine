import { describe, expect, it } from 'vitest';
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamento-repository.memory.js';
import { criarPagamentoPendente } from '../../src/domain/pagamentos.js';
import { PagamentoJaExisteError } from '../../src/errors/pagamento-ja-existe.error.js';
import { PagamentoNaoEncontradoError } from '../../src/errors/pagamento-nao-encontrado.error.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655440201';
const idIntencaoPagamento = '550e8400-e29b-41d4-a716-446655440202';
const idContribuicao = '550e8400-e29b-41d4-a716-446655440203';
const criadoEm = new Date('2026-05-01T12:00:00.000Z');

function makePagamento(id = idPagamento) {
  return criarPagamentoPendente({
    idPagamento: id,
    idIntencaoPagamento,
    composicaoValores: {
      idContribuicao,
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: 8400,
    metodo: 'pix',
    criadoEm,
  });
}

describe('PagamentoRepositoryMemory', () => {
  it('saves and finds a payment by id', async () => {
    const repository = new PagamentoRepositoryMemory();
    const pagamento = makePagamento();

    await repository.save(pagamento);

    await expect(repository.findById(pagamento.id)).resolves.toEqual(pagamento);
  });

  it('rejects duplicate payment ids on save', async () => {
    const repository = new PagamentoRepositoryMemory();
    const pagamento = makePagamento();

    await repository.save(pagamento);

    await expect(repository.save(pagamento)).rejects.toThrow(PagamentoJaExisteError);
  });

  it('updates an existing payment', async () => {
    const repository = new PagamentoRepositoryMemory();
    const pagamento = makePagamento();
    const updated = { ...pagamento, atualizadoEm: new Date('2026-05-01T12:10:00.000Z') };

    await repository.save(pagamento);
    await repository.update(updated);

    await expect(repository.findById(pagamento.id)).resolves.toEqual(updated);
  });

  it('throws when updating a missing payment', async () => {
    const repository = new PagamentoRepositoryMemory();

    await expect(repository.update(makePagamento())).rejects.toThrow(PagamentoNaoEncontradoError);
  });
});
