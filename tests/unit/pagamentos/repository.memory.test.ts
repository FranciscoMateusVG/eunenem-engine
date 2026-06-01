import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import { criarPagamentoPendente } from '../../../src/domain/pagamentos/entities/pagamento.js';
import { PagamentoJaExisteError } from '../../../src/errors/pagamentos/ja-existe.error.js';
import { PagamentoNaoEncontradoError } from '../../../src/errors/pagamentos/nao-encontrado.error.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655440201';
const idIntencaoPagamento = '550e8400-e29b-41d4-a716-446655440202';
const idContribuicao = '550e8400-e29b-41d4-a716-446655440203';
const criadoEm = new Date('2026-05-01T12:00:00.000Z');

function makePagamento(
  id = idPagamento,
  overrides: { idContribuicaoOverride?: string; criadoEmOverride?: Date } = {},
) {
  return criarPagamentoPendente({
    idPagamento: id,
    idIntencaoPagamento: randomUUID(),
    composicaoValores: {
      idContribuicao: overrides.idContribuicaoOverride ?? idContribuicao,
      contributionAmountCents: 8000,
      feeAmountCents: 400,
      totalPaidCents: 8400,
      receiverAmountCents: 8000,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: 8400,
    metodo: 'pix',
    criadoEm: overrides.criadoEmOverride ?? criadoEm,
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

  // ───── findByContribuicao (aperture-i0pz8) ─────

  it('findByContribuicao — returns empty when no pagamentos exist', async () => {
    const repository = new PagamentoRepositoryMemory();
    await expect(repository.findByContribuicao(randomUUID())).resolves.toEqual([]);
  });

  it('findByContribuicao — returns the single matching pagamento', async () => {
    const repository = new PagamentoRepositoryMemory();
    const target = randomUUID();
    const pagamento = makePagamento(randomUUID(), { idContribuicaoOverride: target });
    await repository.save(pagamento);

    const found = await repository.findByContribuicao(target);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(pagamento.id);
  });

  it('findByContribuicao — returns ALL matching pagamentos in criadoEm ASC order', async () => {
    const repository = new PagamentoRepositoryMemory();
    const target = randomUUID();
    const other = randomUUID();

    // Save out-of-order to prove sorting works.
    const newer = makePagamento(randomUUID(), {
      idContribuicaoOverride: target,
      criadoEmOverride: new Date('2026-05-03T00:00:00.000Z'),
    });
    const oldest = makePagamento(randomUUID(), {
      idContribuicaoOverride: target,
      criadoEmOverride: new Date('2026-05-01T00:00:00.000Z'),
    });
    const middle = makePagamento(randomUUID(), {
      idContribuicaoOverride: target,
      criadoEmOverride: new Date('2026-05-02T00:00:00.000Z'),
    });
    const unrelated = makePagamento(randomUUID(), {
      idContribuicaoOverride: other,
      criadoEmOverride: new Date('2026-05-01T12:00:00.000Z'),
    });

    await repository.save(newer);
    await repository.save(oldest);
    await repository.save(middle);
    await repository.save(unrelated);

    const found = await repository.findByContribuicao(target);
    expect(found.map((p) => p.id)).toEqual([oldest.id, middle.id, newer.id]);
    expect(found.map((p) => p.id)).not.toContain(unrelated.id);
  });

  it('findByContribuicao — tolerates the full lifecycle mix (pendente/aprovado/rejeitado)', async () => {
    const repository = new PagamentoRepositoryMemory();
    const target = randomUUID();

    // The factory returns `pendente`. The lifecycle transitions (aprovado/
    // rejeitado) belong to the saga — for this test, we mutate the status
    // field directly since the assertion is "all three states co-exist",
    // not "the use-case correctly transitions them".
    const pendente = makePagamento(randomUUID(), { idContribuicaoOverride: target });
    const aprovado = {
      ...makePagamento(randomUUID(), { idContribuicaoOverride: target }),
      status: 'aprovado' as const,
    };
    const rejeitado = {
      ...makePagamento(randomUUID(), { idContribuicaoOverride: target }),
      status: 'rejeitado' as const,
    };

    await repository.save(pendente);
    await repository.save(aprovado);
    await repository.save(rejeitado);

    const found = await repository.findByContribuicao(target);
    expect(found).toHaveLength(3);
    const statuses = found.map((p) => p.status).sort();
    expect(statuses).toEqual(['aprovado', 'pendente', 'rejeitado']);
  });
});
