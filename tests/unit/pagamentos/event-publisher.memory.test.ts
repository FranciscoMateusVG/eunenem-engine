import { describe, expect, it } from 'vitest';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { criarEventoPagamento } from '../../../src/domain/pagamentos/entities/pagamento.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

const idPagamento = '550e8400-e29b-41d4-a716-446655440401';
const idContribuicao = '550e8400-e29b-41d4-a716-446655440403';
const firstEventId = '550e8400-e29b-41d4-a716-446655440404';
const secondEventId = '550e8400-e29b-41d4-a716-446655440405';
const fixedDate = new Date('2026-05-01T12:00:00.000Z');

describe('PagamentoEventPublisherMemory', () => {
  it('stores published events in order', async () => {
    const publisher = new PagamentoEventPublisherMemory();
    const pagamento = makePagamento({
      id: idPagamento,
      idContribuicao,
      criadoEm: fixedDate,
      metodo: 'pix',
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
