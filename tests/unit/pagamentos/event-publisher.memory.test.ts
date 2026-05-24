import { describe, expect, it } from 'vitest';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import {
  criarEventoPagamento,
  criarPagamentoPendente,
} from '../../../src/domain/pagamentos/entities/pagamento.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655440401';
const idIntencaoPagamento = '550e8400-e29b-41d4-a716-446655440402';
const idContribuicao = '550e8400-e29b-41d4-a716-446655440403';
const firstEventId = '550e8400-e29b-41d4-a716-446655440404';
const secondEventId = '550e8400-e29b-41d4-a716-446655440405';
const fixedDate = new Date('2026-05-01T12:00:00.000Z');

describe('PagamentoEventPublisherMemory', () => {
  it('stores published events in order', async () => {
    const publisher = new PagamentoEventPublisherMemory();
    const pagamento = criarPagamentoPendente({
      idPagamento,
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
      criadoEm: fixedDate,
    });
    const firstEvent = criarEventoPagamento({
      id: firstEventId,
      tipo: 'payment.intent_created',
      pagamento,
      ocorridoEm: fixedDate,
    });
    const secondEvent = criarEventoPagamento({
      id: secondEventId,
      tipo: 'payment.intent_created',
      pagamento,
      ocorridoEm: fixedDate,
    });

    await publisher.publish(firstEvent);
    await publisher.publish(secondEvent);

    expect(publisher.getEventosPublicados()).toEqual([firstEvent, secondEvent]);
  });
});
