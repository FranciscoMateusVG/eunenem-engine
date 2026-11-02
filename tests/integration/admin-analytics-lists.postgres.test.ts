import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
const legacy = { emails: ['legacy@customer.invalid'], completo: true };
beforeAll(async () => {
  t = await createTestDatabase({ isolated: true });
});
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
}
it('Listas uses mature cohorts, ledger time, zero lists, email coverage and disjoint origin/legacy groups', async () => {
  first = await list('2039-08-01T12:00:00Z', 'legacy@customer.invalid', '2039-10-22T12:00:00Z');
  await paid(
    first,
    '2039-08-08T12:00:00Z',
    ' PAYER@customer.invalid ',
    true,
    '2039-09-15T12:00:00Z',
  );
  await paid(first, '2039-08-31T12:00:00Z', 'payer@customer.invalid');
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
