import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  criarItemContribuicao,
  criarItemPassthroughSurcharge,
} from '../../../src/domain/pagamentos/entities/item-do-pagamento.js';
import {
  criarPagamentoPendente,
  type Pagamento,
} from '../../../src/domain/pagamentos/entities/pagamento.js';

/**
 * Plan 0016 Phase 3 (aperture-9uuh4) — webhook contribuinte-projection
 * regression test.
 *
 * Per plan §Phase 3 (and locked decision #14): the contribuinte lives at
 * `IntencaoPagamento` root, NOT on any item. The Stripe webhook handler's
 * `extractContribuinteFromSession → write to intencao.contribuinte`
 * pattern must keep working regardless of how many items the
 * IntencaoPagamento carries.
 *
 * This test exercises the immutable-update shape the
 * stripe-webhook.ts handler uses verbatim (the `processing` branch):
 *
 *   pagamento = {
 *     ...pagamento,
 *     intencao: { ...pagamento.intencao, contribuinte },
 *     atualizadoEm: clock(),
 *   }
 *
 * Asserts:
 *   - contribuinte lands at the IntencaoPagamento root
 *   - items[] are preserved (no accidental mutation)
 *   - aggregate composição is preserved
 *   - idCampanha is preserved
 *
 * The test runs for both 1-item carts (regression for the saga's
 * single-gift happy path) and 3-item carts (regression for the new
 * multi-item cart shape).
 */

const ID_CAMPANHA = '550e8400-e29b-41d4-a716-446655443001';
const CRIADO_EM = new Date('2026-06-09T12:00:00.000Z');
const WEBHOOK_EM = new Date('2026-06-09T12:05:00.000Z');

const CONTRIBUINTE = {
  nome: 'Alice da Silva',
  email: 'alice@example.com',
  mensagem: 'Parabéns! 🎉',
};

function makeContribuicaoItem(idContribuicao: string, quantidade: number, unitContribution: number) {
  return criarItemContribuicao({
    id: randomUUID() as never,
    composicaoValoresItem: {
      tipo: 'contribuicao',
      idContribuicao: idContribuicao as never,
      quantidade,
      contributionUnitAmountCents: unitContribution as never,
      feeUnitAmountCents: (unitContribution * 0.1) as never,
      receiverUnitAmountCents: unitContribution as never,
      lineContributionAmountCents: (unitContribution * quantidade) as never,
      lineFeeAmountCents: (unitContribution * 0.1 * quantidade) as never,
      lineReceiverAmountCents: (unitContribution * quantidade) as never,
    },
    criadoEm: CRIADO_EM,
  });
}

function makeSurchargeItem(amountCents: number) {
  return criarItemPassthroughSurcharge({
    id: randomUUID() as never,
    composicaoValoresItem: { tipo: 'passthrough_surcharge', amountCents: amountCents as never },
    criadoEm: CRIADO_EM,
  });
}

function makePagamentoWithItems(
  items: ReturnType<typeof makeContribuicaoItem | typeof makeSurchargeItem>[],
): Pagamento {
  let totalContribution = 0;
  let totalFee = 0;
  let totalReceiver = 0;
  let totalSurcharge = 0;
  for (const it of items) {
    if (it.tipo === 'contribuicao') {
      const c = it.composicaoValoresItem;
      totalContribution += c.lineContributionAmountCents;
      totalFee += c.lineFeeAmountCents;
      totalReceiver += c.lineReceiverAmountCents;
    } else {
      totalSurcharge += it.composicaoValoresItem.amountCents;
    }
  }
  const totalPaid = totalReceiver + totalFee + totalSurcharge;
  return criarPagamentoPendente({
    idPagamento: randomUUID() as never,
    idIntencaoPagamento: randomUUID() as never,
    items,
    composicaoValoresAggregate: {
      idCampanha: ID_CAMPANHA as never,
      totalContributionCents: totalContribution as never,
      totalFeeCents: totalFee as never,
      totalReceiverCents: totalReceiver as never,
      totalSurchargeCents: totalSurcharge,
      totalPaidCents: totalPaid as never,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: totalPaid as never,
    metodo: items.some((it) => it.tipo === 'passthrough_surcharge') ? 'credit_card' : 'pix',
    criadoEm: CRIADO_EM,
  });
}

/**
 * Mirror of the immutable-update shape used by the Stripe webhook
 * handler at apps/eunenem-server/server/webhooks/stripe-webhook.ts
 * (the `processing` branch around line 480-486 + the pre-finalize
 * write in `finalizarPagamentoAprovado`).
 */
function projectContribuinte(
  pagamento: Pagamento,
  contribuinte: { nome: string; email: string; mensagem?: string },
  clockEm: Date,
): Pagamento {
  return {
    ...pagamento,
    intencao: { ...pagamento.intencao, contribuinte },
    atualizadoEm: clockEm,
  };
}

describe('webhook contribuinte projection — 1-item cart (regression)', () => {
  it('lands contribuinte at IntencaoPagamento root + preserves the single item', () => {
    const idContribuicao = randomUUID();
    const item = makeContribuicaoItem(idContribuicao, 1, 5000);
    const pagamento = makePagamentoWithItems([item]);
    expect(pagamento.intencao.contribuinte).toBeNull();
    expect(pagamento.intencao.items).toHaveLength(1);

    const projected = projectContribuinte(pagamento, CONTRIBUINTE, WEBHOOK_EM);

    expect(projected.intencao.contribuinte).toEqual(CONTRIBUINTE);
    // items + aggregate + idCampanha untouched
    expect(projected.intencao.items).toEqual(pagamento.intencao.items);
    expect(projected.intencao.composicaoValoresAggregate).toEqual(
      pagamento.intencao.composicaoValoresAggregate,
    );
    expect(projected.intencao.idCampanha).toBe(ID_CAMPANHA);
    expect(projected.atualizadoEm.getTime()).toBe(WEBHOOK_EM.getTime());
  });
});

describe('webhook contribuinte projection — 3-item cart (multi-item regression)', () => {
  it('lands contribuinte at root regardless of item count + preserves all items', () => {
    const idContribuicaoA = randomUUID();
    const idContribuicaoB = randomUUID();
    const idContribuicaoC = randomUUID();
    const items = [
      makeContribuicaoItem(idContribuicaoA, 2, 5000),
      makeContribuicaoItem(idContribuicaoB, 1, 3000),
      makeContribuicaoItem(idContribuicaoC, 4, 2000),
    ];
    const pagamento = makePagamentoWithItems(items);
    expect(pagamento.intencao.contribuinte).toBeNull();
    expect(pagamento.intencao.items).toHaveLength(3);

    const projected = projectContribuinte(pagamento, CONTRIBUINTE, WEBHOOK_EM);

    expect(projected.intencao.contribuinte).toEqual(CONTRIBUINTE);
    expect(projected.intencao.items).toHaveLength(3);
    // Items are preserved by reference shape — each item still has its
    // own composição untouched by the contribuinte write.
    for (let i = 0; i < items.length; i++) {
      expect(projected.intencao.items[i]).toEqual(pagamento.intencao.items[i]);
    }
    expect(projected.intencao.composicaoValoresAggregate).toEqual(
      pagamento.intencao.composicaoValoresAggregate,
    );
    expect(projected.intencao.idCampanha).toBe(ID_CAMPANHA);
  });

  it('also works on cartão carts with a surcharge item as the last entry', () => {
    const idContribuicaoA = randomUUID();
    const idContribuicaoB = randomUUID();
    const items = [
      makeContribuicaoItem(idContribuicaoA, 1, 5000),
      makeContribuicaoItem(idContribuicaoB, 2, 3000),
      makeSurchargeItem(800),
    ];
    const pagamento = makePagamentoWithItems(items);
    expect(pagamento.intencao.items).toHaveLength(3);
    expect(pagamento.intencao.items[2]?.tipo).toBe('passthrough_surcharge');

    const projected = projectContribuinte(pagamento, CONTRIBUINTE, WEBHOOK_EM);

    expect(projected.intencao.contribuinte).toEqual(CONTRIBUINTE);
    // Surcharge item is still the LAST entry per operator review lock #18.
    expect(projected.intencao.items[2]?.tipo).toBe('passthrough_surcharge');
    // Aggregate composição preserved (including totalSurchargeCents).
    expect(projected.intencao.composicaoValoresAggregate.totalSurchargeCents).toBe(800);
  });
});

describe('webhook contribuinte projection — idempotent on first-writer-wins shape', () => {
  it('overwrites a prior contribuinte if the second webhook delivery carries different data', () => {
    // First-writer-wins is implemented at the use-case layer (see
    // finalizar-pagamento-aprovado) — the immutable update shape used
    // by the entity-side projection does NOT enforce write-once. This
    // test pins the entity-shape behaviour: applying projection a
    // second time overwrites cleanly without corrupting items.
    const idContribuicao = randomUUID();
    const pagamento = makePagamentoWithItems([makeContribuicaoItem(idContribuicao, 1, 5000)]);

    const firstWrite = projectContribuinte(pagamento, CONTRIBUINTE, WEBHOOK_EM);
    expect(firstWrite.intencao.contribuinte).toEqual(CONTRIBUINTE);

    const SECOND_CONTRIBUINTE = { nome: 'Bob', email: 'bob@example.com' };
    const SECOND_EM = new Date('2026-06-09T12:10:00.000Z');
    const secondWrite = projectContribuinte(firstWrite, SECOND_CONTRIBUINTE, SECOND_EM);

    expect(secondWrite.intencao.contribuinte).toEqual(SECOND_CONTRIBUINTE);
    expect(secondWrite.intencao.items).toEqual(firstWrite.intencao.items);
    expect(secondWrite.atualizadoEm.getTime()).toBe(SECOND_EM.getTime());
  });
});
