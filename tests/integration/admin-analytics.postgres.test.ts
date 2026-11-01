import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let t: TestDatabase;
const now = new Date('2038-10-20T15:00:00Z');
beforeAll(async () => {
  t = await createTestDatabase({ isolated: true });
});
afterAll(async () => {
  await t?.teardown();
});
function caller(allowed = true) {
  const auth = adminAuthOverrides();
  return appRouter.createCaller({
    headers: auth.headers,
    resHeaders: new Headers(),
    deps: {
      ...auth.depsOverrides,
      db: t.db,
      clock: () => now,
      ...(allowed ? {} : { adminAllowedEmails: new Set() }),
    },
  } as unknown as TrpcContext);
}
async function user(
  date: string,
  attribution: 'google' | 'direct' | 'unknown' | 'organic' | 'other' = 'unknown',
  platform = ID_PLATAFORMA_EUNENEM,
  qa = false,
) {
  const id = randomUUID();
  const account = randomUUID();
  await t.db
    .insertInto('usuarios')
    .values({
      id,
      id_conta: account,
      id_plataforma: platform,
      email: qa ? `${id}@example.com` : `${id}@customer.invalid`,
      nome_exibicao: 'Cliente',
      slug: id.slice(0, 30),
      criado_em: new Date(date),
      onboarding_concluido_em: new Date(date),
      signup_captured_at: attribution === 'unknown' ? null : new Date(date),
      signup_gclid: attribution === 'google' ? 'click' : null,
      signup_utm_medium: attribution === 'organic' ? 'organic' : null,
      signup_utm_source: attribution === 'other' ? 'facebook' : null,
    })
    .execute();
  return { id, account };
}
async function campaign(account: string, platform = ID_PLATAFORMA_EUNENEM) {
  const id = randomUUID();
  await t.db
    .insertInto('campanhas')
    .values({
      id,
      id_plataforma: platform,
      titulo: 'Lista',
      criada_em: new Date('2038-08-01T03:00:00Z'),
    })
    .execute();
  await t.db
    .insertInto('campanha_administradores')
    .values({ campanha_id: id, id_usuario: account })
    .execute();
  return id;
}
async function payment(
  campaignId: string,
  opts: {
    created: string;
    approved?: string;
    method?: string;
    expired?: boolean;
    generated?: boolean;
    refunded?: boolean;
    quantity?: number;
  },
) {
  const id = randomUUID();
  const item = randomUUID();
  const gift = randomUUID();
  const created = new Date(opts.created);
  await t.db
    .insertInto('opcoes_contribuicao')
    .values({ id: gift, campanha_id: campaignId, tipo: 'presente' })
    .execute();
  await t.db
    .insertInto('contribuicoes')
    .values({
      id: gift,
      campanha_id: campaignId,
      id_opcao_contribuicao: gift,
      nome: 'Presente',
      valor: 1000,
    })
    .execute();
  await t.db
    .insertInto('pagamentos')
    .values({
      id,
      status: opts.refunded ? 'estornado' : opts.approved ? 'aprovado' : 'pendente',
      criado_em: created,
      atualizado_em: created,
      intencao_id: randomUUID(),
      intencao_id_campanha: campaignId,
      intencao_criada_em: created,
      intencao_metodo: opts.method ?? 'pix',
      intencao_total_contribution_cents: 3000,
      intencao_total_fee_cents: 300,
      intencao_total_receiver_cents: 3000,
      intencao_total_surcharge_cents: 200,
      intencao_total_paid_cents: 3500,
      intencao_external_ref: opts.generated === false ? null : id,
      intencao_expira_em: opts.expired
        ? new Date('2038-10-10T12:00:00Z')
        : new Date('2038-11-01T12:00:00Z'),
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
      quantidade: opts.quantity ?? 3,
      contribution_unit_amount_cents: 1000,
      line_contribution_amount_cents: 3000,
      fee_unit_amount_cents: 100,
      line_fee_amount_cents: 300,
      receiver_unit_amount_cents: 1000,
      line_receiver_amount_cents: 3000,
      criado_em: created,
    })
    .execute();
  if (opts.approved) {
    for (const tipo of ['credito_receita_plataforma', 'credito_saldo_recebedor']) {
      await t.db
        .insertInto('lancamentos_financeiros')
        .values({
          id: randomUUID(),
          id_pagamento: id,
          id_item_pagamento: item,
          id_contribuicao: gift,
          tipo,
          amount_cents: tipo === 'credito_receita_plataforma' ? 300 : 3000,
          criado_em: new Date(opts.approved),
          cancelado_em: opts.refunded ? now : null,
        })
        .execute();
    }
  }
  return id;
}
it('enforces admin auth, input periods and preserves legacy query', async () => {
  await expect(caller(false).admin.analytics.funil({ meses: 3 })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await expect(caller(false).admin.analytics.vendas({ meses: 3 })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  // @ts-expect-error invalid runtime period
  await expect(caller().admin.analytics.funil({ meses: 4 })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  expect((await caller().admin.analytics.funil()).meses).toHaveLength(3);
  expect((await caller().admin.analytics.funil({ meses: 6 })).meses).toHaveLength(6);
  expect((await caller().admin.analytics.funil({ meses: 12 })).meses).toHaveLength(12);
  expect((await caller().admin.estatisticas()).meses).toHaveLength(12);
});
it('counts acquisition cohorts, scopes tenants, maps account IDs and never duplicates multi-list users', async () => {
  const google = await user('2038-08-01T03:00:00Z', 'google');
  const c = await campaign(google.account);
  await campaign(google.account);
  await payment(c, { created: '2038-09-01T12:00:00Z', approved: '2038-09-02T12:00:00Z' });
  await user('2038-09-01T02:59:59Z', 'direct'); // August SP
  await user('2038-09-01T03:00:00Z', 'organic');
  await user('2038-10-03T12:00:00Z', 'other');
  await user('2038-10-04T12:00:00Z');
  await user('2038-10-04T12:00:00Z', 'google', randomUUID());
  await user('2038-10-04T12:00:00Z', 'google', ID_PLATAFORMA_EUNENEM, true);
  await user('2038-11-01T12:00:00Z');
  await user('2038-08-01T02:59:59Z'); // before selected period
  const result = await caller().admin.analytics.funil({ meses: 3 });
  expect(result.totais).toEqual({
    cadastro: 5,
    onboarding: 5,
    lista_criada: 1,
    primeiro_presente: 1,
  });
  expect(result.meses[0]?.contagens).toEqual({
    cadastro: 2,
    onboarding: 2,
    lista_criada: 1,
    primeiro_presente: 1,
  });
  expect(result.porOrigem.map((o) => o.contagens.cadastro)).toEqual([1, 1, 1, 1, 1]);
  expect(result.semanas.reduce((n, s) => n + s.contagens.cadastro, 0)).toBe(5);
  expect(result.semanas.some((s) => s.contagens.cadastro === 0)).toBe(true);
  expect(result.semanas[0]?.parcial).toBe(true);
});
it('sales use one approval per payment, gift quantities, gross contribution only and PIX creation cohorts', async () => {
  const u = await user('2038-07-01T12:00:00Z');
  const c = await campaign(u.account);
  const before = await caller().admin.analytics.vendas({ meses: 3 });
  await payment(c, {
    created: '2038-08-31T12:00:00Z',
    approved: '2038-09-01T03:00:00Z',
    expired: true,
  });
  await payment(c, {
    created: '2038-09-10T12:00:00Z',
    approved: '2038-09-11T12:00:00Z',
    method: 'credit_card',
    refunded: true,
  });
  await payment(c, { created: '2038-10-01T12:00:00Z', expired: true });
  await payment(c, { created: '2038-10-02T12:00:00Z' });
  await payment(c, { created: '2038-10-02T12:00:00Z', generated: false, expired: true });
  await payment(c, { created: '2038-11-01T12:00:00Z', approved: '2038-11-02T12:00:00Z' });
  const other = await campaign(randomUUID(), randomUUID());
  await payment(other, { created: '2038-09-01T12:00:00Z', approved: '2038-09-02T12:00:00Z' });
  const result = await caller().admin.analytics.vendas({ meses: 3 });
  expect(result.totais.gmvCents - before.totais.gmvCents).toBe(6000);
  expect(result.totais.presentes - before.totais.presentes).toBe(6);
  expect(result.totais.ticketMedioCents).toBe(1000);
  expect(result.totais.pixCents - before.totais.pixCents).toBe(3000);
  expect(result.totais.cartaoCents - before.totais.cartaoCents).toBe(3000);
  expect(result.totais.pixGerados - before.totais.pixGerados).toBe(3);
  expect(result.totais.pixPagos - before.totais.pixPagos).toBe(1);
  expect(result.totais.pixExpirados - before.totais.pixExpirados).toBe(1);
  expect(result.meses[0]?.gmvCents).toBe(0);
  expect(result.semanas.reduce((n, s) => n + s.gmvCents, 0)).toBe(result.totais.gmvCents);
});
