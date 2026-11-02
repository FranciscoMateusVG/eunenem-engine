import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  loadAnalyticsCheckout,
  loadAnalyticsEmailCoverage,
  loadAnalyticsPriceBands,
} from '../../apps/eunenem-server/server/admin-analytics-extras.js';
import { loadAnalyticsFinanceiro } from '../../apps/eunenem-server/server/admin-analytics-finance.js';
import { loadAnalyticsListas } from '../../apps/eunenem-server/server/admin-analytics-lists.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let t: TestDatabase;
const now = new Date('2039-10-20T12:00:00Z');
const platform = ID_PLATAFORMA_EUNENEM;
let first: string;
let firstPayment: string;
let secondPayment: string;
const legacy = { emails: ['legacy@customer.invalid'], completo: true };
beforeAll(async () => {
  t = await createTestDatabase({ isolated: true });
}, 60_000);
afterAll(async () => {
  await t?.teardown();
});
async function list(date: string, email: string, event?: string, tenant = platform) {
  const id = randomUUID();
  const user = randomUUID();
  const account = randomUUID();
  await t.db
    .insertInto('usuarios')
    .values({
      id: user,
      id_conta: account,
      id_plataforma: tenant,
      email,
      nome_exibicao: 'Cliente',
      slug: user.slice(0, 30),
      criado_em: new Date(date),
      signup_captured_at: new Date(date),
      signup_gclid: 'click',
    })
    .execute();
  await t.db
    .insertInto('campanhas')
    .values({ id, id_plataforma: tenant, titulo: 'Lista', criada_em: new Date(date) })
    .execute();
  await t.db
    .insertInto('campanha_administradores')
    .values({ campanha_id: id, id_usuario: account })
    .execute();
  if (event)
    await t.db
      .insertInto('eventos')
      .values({ id: randomUUID(), id_campanha: id, data_hora: new Date(event) })
      .execute();
  return id;
}
async function paid(
  campaign: string,
  at: string,
  email: string | null,
  cost = false,
  reversal?: string,
) {
  const id = randomUUID();
  const gift = randomUUID();
  const item = randomUUID();
  const date = new Date(at);
  await t.db
    .insertInto('opcoes_contribuicao')
    .values({ id: gift, campanha_id: campaign, tipo: 'presente' })
    .execute();
  await t.db
    .insertInto('contribuicoes')
    .values({
      id: gift,
      campanha_id: campaign,
      id_opcao_contribuicao: gift,
      nome: 'Presente',
      valor: 1000,
    })
    .execute();
  await t.db
    .insertInto('pagamentos')
    .values({
      id,
      status: reversal ? 'estornado' : 'aprovado',
      criado_em: date,
      atualizado_em: now,
      intencao_id: randomUUID(),
      intencao_id_campanha: campaign,
      intencao_metodo: 'pix',
      intencao_criada_em: date,
      intencao_total_contribution_cents: 1000,
      intencao_total_fee_cents: 100,
      intencao_total_receiver_cents: 1000,
      intencao_total_surcharge_cents: 0,
      intencao_total_paid_cents: 1100,
      intencao_contribuinte_email: email,
    })
    .execute();
  await t.db
    .insertInto('intencao_items')
    .values({
      id: item,
      id_pagamento: id,
      id_intencao_pagamento: id,
      position: 0,
      tipo: 'contribuicao',
      id_contribuicao: gift,
      quantidade: 1,
      contribution_unit_amount_cents: 1000,
      line_contribution_amount_cents: 1000,
      fee_unit_amount_cents: 100,
      line_fee_amount_cents: 100,
      receiver_unit_amount_cents: 1000,
      line_receiver_amount_cents: 1000,
      criado_em: date,
    })
    .execute();
  await t.db
    .insertInto('lancamentos_financeiros')
    .values({
      id: randomUUID(),
      id_pagamento: id,
      id_item_pagamento: item,
      id_contribuicao: gift,
      tipo: 'credito_receita_plataforma',
      amount_cents: 100,
      criado_em: date,
      cancelado_em: reversal ? new Date(reversal) : null,
    })
    .execute();
  if (cost)
    await t.db
      .insertInto('provider_fee_events')
      .values({
        provider: 'inter',
        account_ref: 'fixture',
        environment: 'test',
        external_ref: id,
        payment_id: id,
        amount_cents: 30,
        currency: 'brl',
        occurred_at: date,
        observed_at: date,
        source: 'fixture',
      })
      .execute();
  return id;
}
it('Listas uses mature cohorts, ledger time, zero lists, email coverage and disjoint origin/legacy groups', async () => {
  first = await list('2039-08-01T12:00:00Z', 'legacy@customer.invalid', '2039-10-22T12:00:00Z');
  firstPayment = await paid(
    first,
    '2039-08-08T12:00:00Z',
    ' PAYER@customer.invalid ',
    true,
    '2039-09-15T12:00:00Z',
  );
  secondPayment = await paid(first, '2039-08-31T12:00:00Z', 'payer@customer.invalid');
  await list('2039-09-01T12:00:00Z', 'new@customer.invalid', '2039-10-25T12:00:00Z');
  const immature = await list('2039-10-19T12:00:00Z', 'recent@customer.invalid');
  await paid(immature, '2039-10-19T12:00:00Z', null);
  await list('2039-09-01T12:00:00Z', 'internal@example.com');
  const foreign = await list(
    '2039-09-01T12:00:00Z',
    'foreign@customer.invalid',
    undefined,
    randomUUID(),
  );
  await paid(foreign, '2039-09-02T12:00:00Z', 'payer@customer.invalid');
  const result = await loadAnalyticsListas(t.db, platform, now, 3, legacy);
  expect(result.listas).toBe(3);
  expect(result.primeiroPresente).toMatchObject({
    medianaDias: 3.5,
    p90Dias: 6.3,
    listasComPresente: 2,
    listasSemPresente: 1,
  });
  expect(result.primeiroPresente.janelas).toEqual([
    { dias: 7, elegiveis: 2, semPresente: 2, percentualSemPresente: 100 },
    { dias: 14, elegiveis: 2, semPresente: 1, percentualSemPresente: 50 },
    { dias: 30, elegiveis: 2, semPresente: 1, percentualSemPresente: 50 },
  ]);
  const august = result.coortes.find((c) => c.de === '2039-08-01');
  expect(august).toMatchObject({ origem: 'google_ads', legado: 'sim' });
  expect(august?.horizontes).toEqual([
    {
      dias: 7,
      listasElegiveis: 1,
      listasImaturas: 0,
      gmvCents: 0,
      margemCents: 0,
      pagamentos: 0,
      pagamentosComCusto: 0,
    },
    {
      dias: 30,
      listasElegiveis: 1,
      listasImaturas: 0,
      gmvCents: 1000,
      margemCents: 70,
      pagamentos: 1,
      pagamentosComCusto: 1,
    },
    {
      dias: 60,
      listasElegiveis: 1,
      listasImaturas: 0,
      gmvCents: 2000,
      margemCents: 70,
      pagamentos: 2,
      pagamentosComCusto: 1,
    },
  ]);
  expect(
    result.coortes
      .find((c) => c.de === '2039-10-01')
      ?.horizontes.every((h) => h.listasImaturas === 1 && h.gmvCents === 0),
  ).toBe(true);
  expect(result.pagadores).toMatchObject({
    pagamentosAprovados: 3,
    pagamentosComEmail: 2,
    pagadoresUnicos: 1,
    pagadoresRecorrentes: 1,
    percentualRecorrentes: 100,
  });
  expect(result.risco.semData).toBe(1);
  expect(result.risco.faixas[0]).toMatchObject({
    listas: 1,
    semPrimeiroPresente: 0,
    semPagamento7Dias: 1,
  });
  expect(result.risco.faixas[1]).toMatchObject({ listas: 1, semPrimeiroPresente: 1 });
  expect(result.concentracao).toMatchObject({
    listas: 3,
    listasSemReceita: 1,
    gmvCents: 3000,
    margemCents: 170,
    top10GmvPct: 100,
    top10MargemPct: 100,
  });
  expect(result.coberturaCoortes).toMatchObject({ parcial: true, denominador: 3, observados: 1 });
  expect(JSON.stringify(result)).not.toContain('payer@');
});
it('event curve uses current SP calendar date and labels edits/unknown legacy/empty denominators', async () => {
  await t.db
    .updateTable('eventos')
    .set({ data_hora: new Date('2039-08-31T03:00:00Z') })
    .where('id_campanha', '=', first)
    .execute();
  const result = await loadAnalyticsListas(t.db, platform, now, 3, { emails: [], completo: false });
  expect(result.curvaEvento.dias.find((d) => d.diaRelativo === 0)).toMatchObject({
    pagamentos: 1,
    gmvCents: 1000,
  });
  expect(result.curvaEvento.dias.find((d) => d.diaRelativo === -23)).toMatchObject({
    pagamentos: 1,
    gmvCents: 1000,
  });
  expect(result.curvaEvento.cobertura.nota).toContain('editada');
  expect(result.coortes.every((c) => c.legado === 'desconhecido')).toBe(true);
  const empty = await loadAnalyticsListas(t.db, randomUUID(), now, 6, legacy);
  expect(empty.primeiroPresente.medianaDias).toBeNull();
  expect(empty.concentracao.top10GmvPct).toBeNull();
  expect(empty.primeiroPresente.janelas.every((j) => j.percentualSemPresente === null)).toBe(true);
  const auth = adminAuthOverrides();
  const caller = appRouter.createCaller({
    headers: auth.headers,
    resHeaders: new Headers(),
    deps: { ...auth.depsOverrides, db: t.db, clock: () => now, adminAllowedEmails: new Set() },
  } as unknown as TrpcContext);
  await expect(caller.admin.analytics.listas({ meses: 3 })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
});

it('Financeiro separates observed margin, real payout evidence and overlapping refund/MED amounts', async () => {
  const payout = randomUUID();
  await t.db
    .insertInto('repasses_recebedor')
    .values({
      id: payout,
      id_campanha: first,
      amount_cents: 1000,
      status: 'pago',
      solicitado_em: new Date('2039-10-10T12:00:00Z'),
      aprovado_em: new Date('2039-10-11T12:00:00Z'),
    })
    .execute();
  const item = await t.db
    .selectFrom('intencao_items')
    .select(['id', 'id_contribuicao'])
    .where('id_pagamento', '=', firstPayment)
    .executeTakeFirstOrThrow();
  if (!item.id_contribuicao) throw new Error('fixture requires gift');
  await t.db
    .insertInto('lancamentos_financeiros')
    .values({
      id: randomUUID(),
      id_pagamento: firstPayment,
      id_item_pagamento: item.id,
      id_contribuicao: item.id_contribuicao,
      id_campanha: first,
      id_repasse: payout,
      tipo: 'credito_saldo_recebedor',
      amount_cents: 1000,
      criado_em: new Date('2039-08-08T12:00:00Z'),
      transferido_em: new Date('2039-10-12T12:00:00Z'),
    })
    .execute();
  await t.db
    .insertInto('repasses_recebedor')
    .values({
      id: randomUUID(),
      id_campanha: first,
      amount_cents: 400,
      status: 'aprovado',
      solicitado_em: new Date('2039-10-05T12:00:00Z'),
      aprovado_em: new Date('2039-10-06T12:00:00Z'),
    })
    .execute();
  await t.db
    .insertInto('repasses_recebedor')
    .values({
      id: randomUUID(),
      id_campanha: first,
      amount_cents: 200,
      status: 'pago',
      solicitado_em: new Date('2039-10-10T12:00:00Z'),
      aprovado_em: new Date('2039-10-11T12:00:00Z'),
    })
    .execute();
  await t.db
    .insertInto('pix_contestacoes')
    .values({
      id: randomUUID(),
      id_pagamento: firstPayment,
      valor_cents: 500,
      estado: 'bloqueada',
      ocorrida_em: new Date('2039-10-15T12:00:00Z'),
      criado_por: 'fixture',
    })
    .execute();
  await t.db
    .insertInto('pix_cobranca_devolucoes')
    .values({
      id: randomUUID(),
      id_pagamento: firstPayment,
      e2e_id: 'A'.repeat(32),
      id_devolucao: 'B'.repeat(26),
      amount_cents: 100,
      status: 'devolvida',
      criado_em: new Date('2039-10-16T12:00:00Z'),
    })
    .execute();
  await t.db
    .insertInto('stripe_refund_operations')
    .values({
      operation_id: randomUUID(),
      payment_id: secondPayment,
      origin: 'webhook',
      amount_cents: 200,
      currency: 'brl',
      charge_ref: 'ch_fixture',
      reason: 'requested_by_customer',
      state: 'provider_succeeded',
      provider_status: 'succeeded',
      provider_result_at: new Date('2039-10-16T12:00:00Z'),
      created_at: new Date('2039-10-15T12:00:00Z'),
    })
    .execute();
  const result = await loadAnalyticsFinanceiro(t.db, platform, now, 3);
  expect(result.margem).toMatchObject({
    taxasCents: 300,
    reversoesCents: 100,
    custosCents: 30,
    margemContribuicaoCents: 170,
    listas: 2,
    pagamentos: 3,
    pagamentosComCusto: 1,
    p25Cents: 78,
    p50Cents: 85,
    p90Cents: 97,
  });
  expect(result.repasses.solicitadoAteTransferido).toEqual({
    p50Horas: 48,
    p95Horas: 48,
    observados: 1,
  });
  expect(result.repasses.aprovadoAteTransferido).toEqual({
    p50Horas: 24,
    p95Horas: 24,
    observados: 1,
  });
  expect(result.repasses.confirmadosSemMarco).toBe(1);
  expect(result.repasses.aging).toEqual([
    { estado: 'aprovado', faixa: '8_30d', quantidade: 1, valorCents: 400 },
  ]);
  expect(result.exposicao).toMatchObject({
    medBloqueadoCents: 500,
    medLiberadoCents: 0,
    medDevolvidoCents: 0,
    estornosStripeConfirmadosCents: 200,
    devolucoesPixConfirmadasCents: 100,
    jaRepassadoEmPagamentosContestadosCents: 1000,
    recuperadoPelaPlataformaCents: null,
    cobertura: { parcial: true },
  });
  const empty = await loadAnalyticsFinanceiro(t.db, randomUUID(), now, 3);
  expect(empty.margem.p50Cents).toBeNull();
  expect(empty.exposicao.medBloqueadoCents).toBe(0);
  const auth = adminAuthOverrides();
  const caller = appRouter.createCaller({
    headers: auth.headers,
    resHeaders: new Headers(),
    deps: { ...auth.depsOverrides, db: t.db, clock: () => now, adminAllowedEmails: new Set() },
  } as unknown as TrpcContext);
  await expect(caller.admin.analytics.financeiro()).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

it('operation recovery, mutable price mix and observed email coverage have explicit denominators', async () => {
  const operation = randomUUID();
  await t.db
    .insertInto('payment_provider_operations')
    .values({
      operation_id: operation,
      platform_id: platform,
      campaign_id: first,
      payment_id: secondPayment,
      provider: 'stripe',
      method: 'credit_card',
      capability_hash: 'a'.repeat(64),
      request_hmac: 'b'.repeat(64),
      request_snapshot: {},
      state: 'local_committed',
      provider_ref: 'test-ref',
      provider_succeeded_at: new Date('2039-09-03T12:00:00Z'),
      created_at: new Date('2039-09-01T12:00:00Z'),
      local_committed_at: new Date('2039-09-03T12:00:00Z'),
    })
    .execute();
  for (const [attempt, outcome, at] of [
    [1, 'failed', '2039-09-01'],
    [2, 'outcome_unknown', '2039-09-02'],
    [3, 'provider_succeeded', '2039-09-03'],
  ] as const) {
    await t.db
      .insertInto('payment_provider_operation_attempt_facts')
      .values({
        id: randomUUID(),
        operation_id: operation,
        attempt_no: attempt,
        fact_kind: 'result',
        fence_token: randomUUID(),
        outcome,
        recorded_at: new Date(`${at}T12:00:00Z`),
      })
      .execute();
  }
  const failedOperation = randomUUID();
  await t.db
    .insertInto('payment_provider_operations')
    .values({
      operation_id: failedOperation,
      platform_id: platform,
      campaign_id: first,
      payment_id: firstPayment,
      provider: 'inter',
      method: 'pix',
      capability_hash: 'c'.repeat(64),
      request_hmac: 'd'.repeat(64),
      request_snapshot: {},
      state: 'failed',
      created_at: new Date('2039-09-01T12:00:00Z'),
    })
    .execute();
  for (const [attempt, outcome, at] of [
    [1, 'provider_succeeded', '2039-09-01'],
    [2, 'failed', '2039-09-02'],
  ] as const) {
    await t.db
      .insertInto('payment_provider_operation_attempt_facts')
      .values({
        id: randomUUID(),
        operation_id: failedOperation,
        attempt_no: attempt,
        fact_kind: 'result',
        fence_token: randomUUID(),
        outcome,
        recorded_at: new Date(`${at}T12:00:00Z`),
      })
      .execute();
  }
  const checkout = await loadAnalyticsCheckout(t.db, platform, now, 3);
  expect(checkout).toMatchObject({
    operacoes: 2,
    comErro: 2,
    recuperadasAposErro: 1,
    percentualRecuperadas: 50,
    comprasLogicas: null,
    trocasPixCartao: null,
    estados: [
      { estado: 'failed', quantidade: 1 },
      { estado: 'local_committed', quantidade: 1 },
    ],
  });
  expect(
    (await loadAnalyticsCheckout(t.db, randomUUID(), now, 3)).percentualRecuperadas,
  ).toBeNull();
  // Current catalog price moves to another band, historical item stays R$10.
  await t.db
    .updateTable('contribuicoes')
    .set({ valor: 10000, quantidade: 4 })
    .where('campanha_id', '=', first)
    .execute();
  const prices = await loadAnalyticsPriceBands(t.db, platform, now, 3);
  expect(prices.faixas[0]).toMatchObject({ comprados: 3, gmvCents: 3000 });
  expect(prices.faixas[2]).toMatchObject({ disponiveis: 7, comprados: 0 });
  const owner = await t.db
    .selectFrom('usuarios')
    .select('id')
    .where('email', '=', 'legacy@customer.invalid')
    .executeTakeFirstOrThrow();
  const qa = await t.db
    .selectFrom('usuarios')
    .select('id')
    .where('email', '=', 'internal@example.com')
    .executeTakeFirstOrThrow();
  const event = randomUUID(),
    noRecipient = randomUUID();
  await t.db
    .insertInto('lifecycle_email_events')
    .values(
      [event, noRecipient].map((id) => ({
        id,
        tenant_id: platform,
        type: 'payment_received',
        subject_id: randomUUID(),
        campaign_id: first,
        occurred_at: new Date('2039-09-01T12:00:00Z'),
      })),
    )
    .execute();
  await t.db
    .insertInto('lifecycle_email_deliveries')
    .values([
      {
        id: randomUUID(),
        event_id: event,
        tenant_id: platform,
        type: 'payment_received',
        user_id: owner.id,
        state: 'sent',
      },
      {
        id: randomUUID(),
        event_id: event,
        tenant_id: platform,
        type: 'payment_received',
        user_id: qa.id,
        state: 'failed',
      },
    ])
    .execute();
  const emails = await loadAnalyticsEmailCoverage(t.db, platform, now, 3);
  expect(emails.tipos).toEqual([
    {
      tipo: 'payment_received',
      eventosRegistrados: 2,
      eventosComDestinatario: 1,
      pendentes: 0,
      enviando: 0,
      enviados: 1,
      falhos: 0,
      desconhecidos: 0,
      suprimidos: 0,
    },
  ]);
  expect(emails.cobertura).toMatchObject({ denominador: 2, observados: 1, parcial: true });
  expect((await loadAnalyticsEmailCoverage(t.db, randomUUID(), now, 3)).tipos).toEqual([]);
  const auth = adminAuthOverrides();
  const caller = appRouter.createCaller({
    headers: auth.headers,
    resHeaders: new Headers(),
    deps: { ...auth.depsOverrides, db: t.db, clock: () => now },
  } as unknown as TrpcContext);
  expect((await caller.admin.analytics.funil({ meses: 3 })).checkout.operacoes).toBe(2);
  expect((await caller.admin.analytics.vendas({ meses: 3 })).faixasPreco.faixas).toHaveLength(5);
  expect((await caller.admin.analytics.saude({ meses: 3 })).emailCobertura.tipos).toHaveLength(1);
});

it('bank acceptance timing is separate from paid evidence and ignores failure, approval and future markers', async () => {
  const tenant = randomUUID();
  const campaign = await list(
    '2039-09-01T12:00:00Z',
    'bank-acceptance@customer.invalid',
    undefined,
    tenant,
  );
  const request = new Date('2039-10-10T12:00:00Z');
  const ids = Array.from({ length: 5 }, () => randomUUID());
  await t.db
    .insertInto('repasses_recebedor')
    .values(
      ids.map((id, index) => ({
        id,
        id_campanha: campaign,
        amount_cents: 1000,
        status: index < 2 ? 'enviado_ao_banco' : 'aprovado',
        inter_codigo_solicitacao: index < 2 ? randomUUID() : null,
        solicitado_em: request,
        aprovado_em: new Date('2039-10-10T13:00:00Z'),
        enviado_ao_banco_em:
          index === 0
            ? new Date('2039-10-11T12:00:00Z')
            : index === 1
              ? new Date('2039-10-13T12:00:00Z')
              : null,
      })),
    )
    .execute();
  for (const [index, attempt, outcome, date] of [
    [1, 1, 'aceito_pelo_banco', '2039-10-12'],
    [1, 2, 'aceito_pelo_banco', '2039-10-14'],
    [2, 1, 'falhou', '2039-10-11'],
    [3, 1, 'aceito_pelo_banco', '2039-10-21'],
    [4, 1, 'aceito_pelo_banco', '2039-10-09'],
  ] as const) {
    await t.db
      .insertInto('repasse_transfer_attempts')
      .values({
        id: randomUUID(),
        repasse_id: ids[index] ?? '',
        attempt_no: attempt,
        referencia: randomUUID(),
        operation: 'pagar_pix',
        started_at: request,
        finished_at: new Date(`${date}T12:00:00Z`),
        outcome,
      })
      .execute();
  }
  const result = await loadAnalyticsFinanceiro(t.db, tenant, now, 3);
  expect(result.repasses).toMatchObject({
    solicitadoAteAceito: { p50Horas: 36, p95Horas: 46.8, observados: 2 },
    coberturaAceite: { denominador: 5, observados: 2, parcial: true },
    solicitadoAteTransferido: { p50Horas: null, p95Horas: null, observados: 0 },
  });
  expect(result.repasses.coberturaAceite.nota).toContain('não confirmação de crédito');
});
