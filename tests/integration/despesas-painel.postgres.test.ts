import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { ProviderFeeSync } from '../../src/use-cases/pagamentos/provider-fee-sync.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { ReceitaLedgerSeed } from '../helpers/receita-ledger-seed.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * aperture-5qoz0 PR3 — aba Despesas contra Postgres real, pelo router.
 *
 * Despesa = tarifa de processamento OBSERVADA no provedor
 * (`provider_fee_events`), datada pelo débito (`occurred_at`). Nenhuma
 * estimativa: pagamento sem tarifa confirmada aparece como pendente/falho na
 * cobertura, nunca como R$ 0.
 *
 * Calendário igual ao da Receita 1b: hoje = segunda 05/10/2037 12:00 SP.
 *   30/09 23:59 SP ⇒ setembro;  01/10 00:00 SP ⇒ outubro, semana 01–04/10;
 *   04/10 23:59 SP ⇒ domingo;   05/10 00:00 SP ⇒ semana corrente 05–11/10.
 */

const OTHER_PLATFORM = '00000000-0000-4000-8000-00000000d5e5';
const NOW = new Date('2037-10-05T15:00:00.000Z');

function sp(local: string): Date {
  return new Date(`${local}-03:00`);
}

let testDb: TestDatabase;
let seed: ReceitaLedgerSeed;

async function limparTarifas() {
  await sql`DELETE FROM provider_fee_events`.execute(testDb.db);
  await sql`DELETE FROM provider_fee_sync`.execute(testDb.db);
  await sql`DELETE FROM provider_fee_inter_scans`.execute(testDb.db);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  seed = new ReceitaLedgerSeed(testDb.db);
});

afterAll(async () => {
  await limparTarifas();
  await seed.wipe();
  await testDb.teardown();
});

beforeEach(async () => {
  await limparTarifas();
  await seed.wipe();
});

function caller(opts: { sessao?: boolean; allowlist?: string[] } = {}) {
  const auth = adminAuthOverrides();
  const deps = {
    ...auth.depsOverrides,
    ...(opts.allowlist ? { adminAllowedEmails: new Set(opts.allowlist) } : {}),
    db: testDb.db,
    clock: () => NOW,
    logPiiHashSalt: 'despesas-integration-salt',
  } as unknown as ServerDeps;
  const ctx: TrpcContext = {
    deps,
    headers: opts.sessao === false ? new Headers() : auth.headers,
    resHeaders: new Headers(),
  };
  return appRouter.createCaller(ctx);
}

/** Uma tarifa observada, no shape que o sync do PR1/PR2 grava. */
async function tarifa(input: {
  provider: 'stripe' | 'inter';
  amountCents: number;
  occurredAt: Date;
  paymentId: string | null;
  observedAt?: Date;
}) {
  await sql`
    INSERT INTO provider_fee_events
      (provider, account_ref, environment, external_ref, payment_id, amount_cents,
       currency, occurred_at, observed_at, source)
    VALUES (${input.provider}, 'acct_fixture', 'live', ${`ref-${randomUUID()}`},
      ${input.paymentId}::uuid, ${input.amountCents}, 'brl', ${input.occurredAt},
      ${input.observedAt ?? NOW}, 'fixture')
  `.execute(testDb.db);
}

async function sync(paymentId: string, status: 'pending' | 'confirmed' | 'failed', at = NOW) {
  await sql`
    INSERT INTO provider_fee_sync (payment_id, status, attempts, next_attempt_at, updated_at)
    VALUES (${paymentId}::uuid, ${status}, 1, ${at}, ${at})
  `.execute(testDb.db);
}

async function scan(
  dia: string,
  o: { conta?: string; sucesso?: Date; tentativas?: number; motivo?: string },
) {
  await sql`
    INSERT INTO provider_fee_inter_scans (account_ref, day, last_success_at, last_reason, attempts)
    VALUES (${o.conta ?? 'acct_fixture'}, ${dia}::date, ${o.sucesso ?? null},
      ${o.motivo ?? null}, ${o.tentativas ?? 0})
  `.execute(testDb.db);
}

async function cartao(campaignId: string, criadoEm: Date, status?: 'aprovado' | 'estornado') {
  const p = await seed.pagamento({
    campaignId,
    taxaCents: 500,
    criadoEm,
    provedor: 'stripe',
    metodo: 'credit_card',
    ...(status === 'estornado' ? { canceladoEm: criadoEm } : {}),
  });
  return p.idPagamento;
}

async function pix(campaignId: string, criadoEm: Date) {
  const p = await seed.pagamento({ campaignId, taxaCents: 300, criadoEm, provedor: 'inter' });
  return p.idPagamento;
}

describe('Despesas — valores pela data de débito (occurred_at) em São Paulo', () => {
  async function seedOutubro() {
    const campanha = await seed.campanha();
    const outra = await seed.campanha(OTHER_PLATFORM);
    // Débito em 30/09 23:59 SP (UTC já é 01/10) ⇒ setembro.
    const setembro = await cartao(campanha, sp('2037-09-30T20:00:00'));
    await tarifa({
      provider: 'stripe',
      amountCents: 467,
      occurredAt: sp('2037-09-30T23:59:00'),
      paymentId: setembro,
    });
    const virada = await pix(campanha, sp('2037-10-01T00:00:00'));
    await tarifa({
      provider: 'inter',
      amountCents: 99,
      occurredAt: sp('2037-10-01T00:00:00'),
      paymentId: virada,
    });
    const domingo = await cartao(campanha, sp('2037-10-04T22:00:00'));
    await tarifa({
      provider: 'stripe',
      amountCents: 312,
      occurredAt: sp('2037-10-04T23:59:00'),
      paymentId: domingo,
    });
    const segunda = await pix(campanha, sp('2037-10-05T00:00:00'));
    await tarifa({
      provider: 'inter',
      amountCents: 99,
      occurredAt: sp('2037-10-05T00:00:00'),
      paymentId: segunda,
    });
    // Estorno não apaga a tarifa original.
    const estornado = await cartao(campanha, sp('2037-10-05T08:00:00'), 'estornado');
    await tarifa({
      provider: 'stripe',
      amountCents: 250,
      occurredAt: sp('2037-10-05T08:01:00'),
      paymentId: estornado,
    });
    // Outra plataforma: nenhum número.
    const alheio = await cartao(outra, sp('2037-10-03T12:00:00'));
    await tarifa({
      provider: 'stripe',
      amountCents: 9_999,
      occurredAt: sp('2037-10-03T12:00:00'),
      paymentId: alheio,
    });
    // Tarifa Inter sem vínculo: fora do total, mas visível.
    await tarifa({
      provider: 'inter',
      amountCents: 150,
      occurredAt: sp('2037-10-02T09:00:00'),
      paymentId: null,
    });
    await tarifa({
      provider: 'inter',
      amountCents: 150,
      occurredAt: sp('2037-10-05T09:00:00'),
      paymentId: null,
    });
    // Fora da janela (meses demais atrás): não entra em nada.
    const antigo = await cartao(campanha, sp('2036-01-10T12:00:00'));
    await tarifa({
      provider: 'stripe',
      amountCents: 7_777,
      occurredAt: sp('2036-01-10T12:00:00'),
      paymentId: antigo,
    });
  }

  it('KPIs separam Stripe (cartão), Inter (PIX) e total; semana e mês nas bordas de SP', async () => {
    await seedOutubro();
    const d = await caller().admin.despesas.painel();
    expect(d.hoje).toBe('2037-10-05');
    expect(d.timezone).toBe('America/Sao_Paulo');
    const v = (k: keyof typeof d.kpis) => [
      d.kpis[k].de,
      d.kpis[k].ate,
      d.kpis[k].stripeCents,
      d.kpis[k].interCents,
      d.kpis[k].totalCents,
    ];
    expect(v('mesAtual')).toEqual([
      '2037-10-01',
      '2037-10-06',
      312 + 250,
      99 + 99,
      312 + 250 + 198,
    ]);
    expect(v('mesAnterior')).toEqual(['2037-09-01', '2037-10-01', 467, 0, 467]);
    expect(v('semanaAtual')).toEqual(['2037-10-05', '2037-10-12', 250, 99, 349]);
    expect(v('semanaAnterior')).toEqual([
      '2037-09-28',
      '2037-10-05',
      467 + 312,
      99,
      467 + 312 + 99,
    ]);
    expect(d.kpis.mesAtual.naoVinculadas).toEqual({ count: 2, cents: 300 });
    expect(d.kpis.semanaAtual.naoVinculadas).toEqual({ count: 1, cents: 150 });
    expect(d.kpis.mesAnterior.naoVinculadas).toEqual({ count: 0, cents: 0 });
  });

  it('12 meses (o corrente parcial) e semanas do mês recortadas', async () => {
    await seedOutubro();
    const d = await caller().admin.despesas.painel();
    expect(d.meses).toHaveLength(12);
    expect(d.meses.at(-1)).toMatchObject({ de: '2037-10-01', parcial: true, totalCents: 760 });
    expect(d.meses.at(-2)).toMatchObject({ de: '2037-09-01', parcial: false, totalCents: 467 });
    expect(d.meses.slice(0, -2).every((m) => m.totalCents === 0)).toBe(true);
    expect(d.semanas.map((s) => [s.de, s.ate, s.estado, s.stripeCents, s.interCents])).toEqual([
      ['2037-10-01', '2037-10-05', 'passada', 312, 99],
      ['2037-10-05', '2037-10-12', 'atual', 250, 99],
      ['2037-10-12', '2037-10-19', 'futura', 0, 0],
      ['2037-10-19', '2037-10-26', 'futura', 0, 0],
      ['2037-10-26', '2037-11-01', 'futura', 0, 0],
    ]);
    expect(d.diferencaConciliacao).toEqual({
      stripeCents: 0,
      interCents: 0,
      naoVinculadasCents: 0,
    });
  });
});

describe('Despesas — cobertura: pendente é pendente, nunca zero', () => {
  it('Stripe: confirmado/pendente/falho por data do pagamento; elegível sem linha de sync é pendente', async () => {
    const campanha = await seed.campanha();
    const confirmado = await cartao(campanha, sp('2037-10-05T09:00:00'));
    await sync(confirmado, 'confirmed', sp('2037-10-05T10:00:00'));
    await tarifa({
      provider: 'stripe',
      amountCents: 400,
      occurredAt: sp('2037-10-05T09:00:00'),
      paymentId: confirmado,
      observedAt: sp('2037-10-05T10:00:00'),
    });
    const pendente = await cartao(campanha, sp('2037-10-02T09:00:00'));
    await sync(pendente, 'pending', sp('2037-10-05T11:00:00'));
    const falho = await cartao(campanha, sp('2037-09-15T09:00:00'));
    await sync(falho, 'failed', sp('2037-10-01T11:00:00'));
    // Elegível, ainda não admitido pelo sync.
    await cartao(campanha, sp('2037-10-05T11:30:00'));
    // Estornado continua elegível (a tarifa original existe).
    const estornado = await cartao(campanha, sp('2037-10-03T09:00:00'), 'estornado');
    await sync(estornado, 'confirmed', sp('2037-10-04T09:00:00'));
    // Não elegíveis: PIX, outra plataforma, pendente/rejeitado.
    await pix(campanha, sp('2037-10-05T09:00:00'));
    await cartao(await seed.campanha(OTHER_PLATFORM), sp('2037-10-05T09:00:00'));
    await seed.pagamento({
      campaignId: campanha,
      taxaCents: 1,
      criadoEm: sp('2037-10-05T09:00:00'),
      status: 'pendente',
      semLancamento: true,
      metodo: 'credit_card',
    });

    const d = await caller().admin.despesas.painel();
    const stripe = d.cobertura.stripe;
    const k = (b: { cobertura: { stripe: unknown } }) => b.cobertura.stripe;
    expect(k(d.kpis.semanaAtual)).toEqual({ confirmados: 1, pendentes: 1, falhos: 0 });
    expect(k(d.kpis.mesAtual)).toEqual({ confirmados: 2, pendentes: 2, falhos: 0 });
    // Comparações e barras recebem a própria cobertura: setembro tem uma falha.
    expect(k(d.kpis.mesAnterior)).toEqual({ confirmados: 0, pendentes: 0, falhos: 1 });
    expect(k(d.kpis.semanaAnterior)).toEqual({ confirmados: 1, pendentes: 1, falhos: 0 });
    expect(k(d.meses.at(-2) as (typeof d.meses)[number])).toEqual(k(d.kpis.mesAnterior));
    expect(k(d.meses.at(-1) as (typeof d.meses)[number])).toEqual(k(d.kpis.mesAtual));
    expect(d.semanas.map((s) => k(s))).toEqual([
      { confirmados: 1, pendentes: 1, falhos: 0 },
      { confirmados: 1, pendentes: 1, falhos: 0 },
      { confirmados: 0, pendentes: 0, falhos: 0 },
      { confirmados: 0, pendentes: 0, falhos: 0 },
      { confirmados: 0, pendentes: 0, falhos: 0 },
    ]);
    expect(stripe.desdeInicio).toEqual({ confirmados: 2, pendentes: 2, falhos: 1 });
    expect(stripe.ultimaLeituraEm).toBe(sp('2037-10-05T11:00:00').toISOString());

    // O mesmo universo que o sync do PR1 considera elegível.
    const dry = await new ProviderFeeSync(testDb.db, null, ID_PLATAFORMA_EUNENEM, () => NOW).run({
      dryRun: true,
    });
    const { confirmados, pendentes, falhos } = stripe.desdeInicio;
    expect(confirmados + pendentes + falhos).toBe(dry.eligible);
  });

  it('sem nenhuma tarifa observada: valores 0 mas cobertura mostra tudo pendente', async () => {
    const campanha = await seed.campanha();
    await cartao(campanha, sp('2037-10-05T09:00:00'));
    const d = await caller().admin.despesas.painel();
    expect(d.kpis.mesAtual.totalCents).toBe(0);
    expect(d.kpis.mesAtual.cobertura.stripe).toEqual({ confirmados: 0, pendentes: 1, falhos: 0 });
    expect(d.cobertura.stripe.ultimaLeituraEm).toBeNull();
  });

  it('Inter: confirmado só com tarifa vinculada; scan vazio NÃO confirma zero; dia esgotado é falha', async () => {
    const campanha = await seed.campanha();
    // Confirmado: tarifa Inter vinculada ao pagamento.
    const confirmado = await pix(campanha, sp('2037-10-05T09:00:00'));
    await tarifa({
      provider: 'inter',
      amountCents: 99,
      occurredAt: sp('2037-10-05T09:00:00'),
      paymentId: confirmado,
      observedAt: sp('2037-10-05T11:00:00'),
    });
    // Dia escaneado com sucesso, sem tarifa para este pagamento: pendente.
    await pix(campanha, sp('2037-10-05T08:00:00'));
    await scan('2037-10-05', { sucesso: sp('2037-10-05T11:30:00') });
    // Dia sem scan nenhum: pendente.
    await pix(campanha, sp('2037-10-02T10:00:00'));
    // Dia esgotado (8 tentativas com erro, sem sucesso): falha.
    await pix(campanha, sp('2037-09-15T10:00:00'));
    await scan('2037-09-15', { tentativas: 8, motivo: 'unavailable' });
    // Esgotado numa conta mas com sucesso noutra: não é falha.
    await pix(campanha, sp('2037-09-16T10:00:00'));
    await scan('2037-09-16', { tentativas: 8, motivo: 'unavailable' });
    await scan('2037-09-16', { conta: 'outra-conta', sucesso: sp('2037-09-17T10:00:00') });
    // Tarifa sem vínculo não confirma pagamento nenhum.
    await tarifa({
      provider: 'inter',
      amountCents: 99,
      occurredAt: sp('2037-10-02T10:00:00'),
      paymentId: null,
      observedAt: sp('2037-10-05T10:00:00'),
    });
    // Não elegíveis: PIX pendente, cartão, outra plataforma.
    await seed.pagamento({
      campaignId: campanha,
      taxaCents: 1,
      criadoEm: sp('2037-10-05T09:00:00'),
      status: 'pendente',
      semLancamento: true,
      provedor: 'inter',
    });
    await cartao(campanha, sp('2037-10-05T09:00:00'));
    await pix(await seed.campanha(OTHER_PLATFORM), sp('2037-10-05T09:00:00'));

    const d = await caller().admin.despesas.painel();
    const inter = d.cobertura.inter;
    expect(d.kpis.semanaAtual.cobertura.inter).toEqual({ confirmados: 1, pendentes: 1, falhos: 0 });
    expect(d.kpis.mesAtual.cobertura.inter).toEqual({ confirmados: 1, pendentes: 2, falhos: 0 });
    expect(d.kpis.mesAnterior.cobertura.inter).toEqual({ confirmados: 0, pendentes: 1, falhos: 1 });
    expect(d.kpis.semanaAnterior.cobertura.inter).toEqual({
      confirmados: 0,
      pendentes: 1,
      falhos: 0,
    });
    expect(inter.desdeInicio).toEqual({ confirmados: 1, pendentes: 3, falhos: 1 });
    expect(inter.desde).toBe('2026-09-01');
    expect(inter.ultimaLeituraEm).toBe(sp('2037-10-05T11:30:00').toISOString());
  });
});

describe('Despesas — acesso', () => {
  it('bloqueia sem sessão (UNAUTHORIZED) e fora da allowlist (FORBIDDEN)', async () => {
    await expect(caller({ sessao: false }).admin.despesas.painel()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      caller({ allowlist: ['outra-pessoa@example.com'] }).admin.despesas.painel(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
