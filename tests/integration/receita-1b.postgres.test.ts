import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { PixCobrancaDevolucaoRepositoryPostgres } from '../../src/adapters/pagamentos/pix-cobranca-devolucao-repository.postgres.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { ReceitaLedgerSeed } from '../helpers/receita-ledger-seed.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * aperture-q4pfz — tela Receita 1b contra Postgres real, pelo router.
 *
 * Calendário: outubro de 2037 repete outubro de 2026 (dia 1 é quinta), o
 * mesmo mês do design. Datas distantes isolam este arquivo do resíduo de
 * outras suítes no container compartilhado.
 *
 * Hoje = segunda 05/10/2037 12:00 em São Paulo (UTC−3, sem horário de verão).
 *
 * Bordas cobertas pelas fixtures:
 *   30/09 23:59 SP  ⇒ setembro (UTC já é 01/10)
 *   01/10 00:00 SP  ⇒ outubro, semana 01–04/10 (qui a dom)
 *   04/10 23:59 SP  ⇒ domingo, ainda semana 01–04/10
 *   05/10 00:00 SP  ⇒ segunda, semana corrente 05–11/10
 *   taxa de agosto cancelada em 02/10 ⇒ +agosto, −outubro (semana 01–04/10)
 *   outra plataforma em 03/10 ⇒ nenhum número
 */

const OTHER_PLATFORM = '00000000-0000-4000-8000-00000000f1b1';
const NOW = new Date('2037-10-05T15:00:00.000Z');

/** Instante de uma data/hora local em São Paulo (UTC−3 fixo em 2037). */
function sp(local: string): Date {
  return new Date(`${local}-03:00`);
}

let testDb: TestDatabase;
let seed: ReceitaLedgerSeed;

beforeAll(async () => {
  testDb = await createTestDatabase();
  seed = new ReceitaLedgerSeed(testDb.db);
});

afterAll(async () => {
  await seed.wipe();
  await testDb.teardown();
});

beforeEach(async () => {
  await seed.wipe();
});

function caller(opts: { sessao?: boolean; allowlist?: string[] } = {}) {
  const auth = adminAuthOverrides();
  const deps = {
    ...auth.depsOverrides,
    ...(opts.allowlist ? { adminAllowedEmails: new Set(opts.allowlist) } : {}),
    db: testDb.db,
    clock: () => NOW,
    logPiiHashSalt: 'receita-1b-integration-salt',
  } as unknown as ServerDeps;
  const ctx: TrpcContext = {
    deps,
    headers: opts.sessao === false ? new Headers() : auth.headers,
    resHeaders: new Headers(),
  };
  return appRouter.createCaller(ctx);
}

/** Cenário de outubro/2037 descrito no cabeçalho. */
async function seedOutubro() {
  const campanha = await seed.campanha();
  const outra = await seed.campanha(OTHER_PLATFORM);
  const viradaSetembro = await seed.pagamento({
    campaignId: campanha,
    taxaCents: 700,
    criadoEm: sp('2037-09-30T23:59:00'),
    provedor: 'stripe',
  });
  const viradaOutubro = await seed.pagamento({
    campaignId: campanha,
    taxaCents: 300,
    criadoEm: sp('2037-10-01T00:00:00'),
    provedor: 'inter',
  });
  const domingo = await seed.pagamento({
    campaignId: campanha,
    taxaCents: 200,
    criadoEm: sp('2037-10-04T23:59:00'),
    provedor: 'stripe',
  });
  const segunda = await seed.pagamento({
    campaignId: campanha,
    taxaCents: 50,
    criadoEm: sp('2037-10-05T00:00:00'),
    provedor: 'inter',
  });
  const estornoStripe = await seed.pagamento({
    campaignId: campanha,
    taxaCents: 1_000,
    criadoEm: sp('2037-08-10T12:00:00'),
    canceladoEm: sp('2037-10-02T12:00:00'),
    provedor: 'stripe',
  });
  const outraPlataforma = await seed.pagamento({
    campaignId: outra,
    taxaCents: 999,
    criadoEm: sp('2037-10-03T12:00:00'),
  });
  return {
    campanha,
    viradaSetembro,
    viradaOutubro,
    domingo,
    segunda,
    estornoStripe,
    outraPlataforma,
  };
}

describe('fixtures da Receita 1b carregam pelos repositórios reais', () => {
  it('pagamentos Stripe, Inter e estornado viram agregados válidos', async () => {
    const s = await seedOutubro();
    const repo = new PagamentoRepositoryPostgres(testDb.db);
    const stripe = await repo.findById(s.viradaSetembro.idPagamento as never);
    const inter = await repo.findById(s.viradaOutubro.idPagamento as never);
    const estornado = await repo.findById(s.estornoStripe.idPagamento as never);
    expect(stripe?.status).toBe('aprovado');
    expect(inter?.status).toBe('aprovado');
    expect(estornado?.status).toBe('estornado');
  });

  it('as linhas do ledger de cada pagamento somam intencao_total_paid_cents', async () => {
    const campanha = await seed.campanha();
    const cartao = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 450,
      contribuicaoCents: 9_000,
      adicionalCents: 380,
      metodo: 'credit_card',
      criadoEm: sp('2037-10-02T09:00:00'),
    });
    const pix = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 120,
      criadoEm: sp('2037-10-02T09:30:00'),
      provedor: 'inter',
    });
    expect(cartao.pagoCents).toBe(9_000 + 450 + 380);
    const rows = await testDb.db
      .selectFrom('lancamentos_financeiros as l')
      .innerJoin('pagamentos as p', 'p.id', 'l.id_pagamento')
      .select(['p.id', 'p.intencao_total_paid_cents as pago'])
      .select((eb) => eb.fn.sum<string>('l.amount_cents').as('soma'))
      .select((eb) => eb.fn.count<string>('l.id').as('linhas'))
      .where('p.id', 'in', [cartao.idPagamento, pix.idPagamento])
      .groupBy(['p.id', 'p.intencao_total_paid_cents'])
      .execute();
    const porId = new Map(rows.map((r) => [r.id, r]));
    expect(Number(porId.get(cartao.idPagamento)?.soma)).toBe(cartao.pagoCents);
    expect(Number(porId.get(cartao.idPagamento)?.linhas)).toBe(3);
    expect(Number(porId.get(pix.idPagamento)?.soma)).toBe(pix.pagoCents);
    expect(Number(porId.get(pix.idPagamento)?.linhas)).toBe(2);
    expect(Number(porId.get(pix.idPagamento)?.pago)).toBe(pix.pagoCents);
  });

  it('devolução PIX do Inter carrega pelo repositório de devoluções', async () => {
    const campanha = await seed.campanha();
    const pago = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 400,
      criadoEm: sp('2037-09-10T10:00:00'),
      provedor: 'inter',
    });
    await seed.devolucaoInter({
      idPagamento: pago.idPagamento,
      amountCents: 1_500,
      criadoEm: sp('2037-10-02T10:00:00'),
    });
    const devolucao = await new PixCobrancaDevolucaoRepositoryPostgres(testDb.db).findByPagamentoId(
      pago.idPagamento as never,
    );
    expect(devolucao).toMatchObject({ amountCents: 1_500, status: 'devolvida' });
  });
});

describe('Tarifas EuNeném (resultado de taxas existente) nas bordas de São Paulo', () => {
  it('mês: virada 30/09 23:59 fica em setembro; cancelamento conta no mês em que ocorreu', async () => {
    await seedOutubro();
    const d = await caller().admin.receita.dashboard({
      de: '2037-08-01',
      ate: '2037-11-01',
      granularidade: 'mes',
    });
    expect(d.serie.map((b) => [b.inicio, b.resultadoDeTaxasCents, b.parcial])).toEqual([
      ['2037-08-01', 1_000, false],
      ['2037-09-01', 700, false],
      ['2037-10-01', 300 + 200 + 50 - 1_000, false],
    ]);
    // KPI "Mês atual" usa o relógio injetado: outubro inteiro até agora.
    expect(d.cards.mesAtual).toMatchObject({
      de: '2037-10-01',
      ate: '2037-11-01',
      resultadoDeTaxasCents: -450,
    });
    // Outra plataforma não aparece em nenhum número.
    expect(d.cards.periodo.taxasRegistradasCents).toBe(1_000 + 700 + 300 + 200 + 50);
  });

  it('semana seg–dom recortada no mês: 01–04/10 (qui a dom) e 05–11/10 corrente', async () => {
    await seedOutubro();
    const d = await caller().admin.receita.dashboard({
      de: '2037-10-01',
      ate: '2037-11-01',
      granularidade: 'semana',
    });
    expect(d.serie.map((b) => [b.inicio, b.fim, b.parcial, b.resultadoDeTaxasCents])).toEqual([
      // A semana ISO começa na segunda 28/09; o recorte do mês deixa só 01–04/10,
      // então os 700 de 30/09 23:59 não entram.
      ['2037-09-28', '2037-10-05', true, 300 + 200 - 1_000],
      ['2037-10-05', '2037-10-12', false, 50],
      ['2037-10-12', '2037-10-19', false, 0],
      ['2037-10-19', '2037-10-26', false, 0],
      ['2037-10-26', '2037-11-02', true, 0],
    ]);
    expect(d.cards.semanaAtual).toMatchObject({
      de: '2037-10-05',
      ate: '2037-10-12',
      resultadoDeTaxasCents: 50,
    });
  });
});

describe('admin.receita bloqueia quem não é admin (Postgres real)', () => {
  const periodo = { de: '2037-10-01', ate: '2037-11-01', granularidade: 'mes' } as const;

  it('sem sessão ⇒ UNAUTHORIZED', async () => {
    await expect(caller({ sessao: false }).admin.receita.dashboard(periodo)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('sessão fora da allowlist ⇒ FORBIDDEN', async () => {
    await expect(
      caller({ allowlist: ['outra-pessoa@example.com'] }).admin.receita.dashboard(periodo),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ────────────────────────────────────────────────────────────────────
//  admin.receita.painel — contrato do coder (aperture-q4pfz)
//
//  recebido = SUM das 3 linhas do pagamento aprovado (saldo do recebedor +
//  taxa + adicional) por criado_em − SUM das mesmas linhas por cancelado_em.
//  Só existem estornos totais: Stripe parcial não cancela linha nenhuma;
//  devolução Inter só desconta quando o ledger foi cancelado.
// ────────────────────────────────────────────────────────────────────

/** seedOutubro + Inter estornado, Stripe parcial e devolução Inter pendente. */
async function seedPainel() {
  const base = await seedOutubro();
  // Inter aprovado 30/09 23:30 SP (último dia do mês), estornado em 03/10.
  const interEstornado = await seed.pagamento({
    campaignId: base.campanha,
    taxaCents: 400,
    contribuicaoCents: 8_000,
    criadoEm: sp('2037-09-30T23:30:00'),
    canceladoEm: sp('2037-10-03T10:00:00'),
    provedor: 'inter',
  });
  await seed.devolucaoInter({
    idPagamento: interEstornado.idPagamento,
    amountCents: interEstornado.pagoCents,
    criadoEm: sp('2037-10-03T09:50:00'),
    atualizadoEm: sp('2037-10-03T10:00:00'),
  });
  // Cartão com adicional e estorno PARCIAL no Stripe: só log, segue aprovado.
  const stripeParcial = await seed.pagamento({
    campaignId: base.campanha,
    taxaCents: 450,
    contribuicaoCents: 9_000,
    adicionalCents: 380,
    metodo: 'credit_card',
    criadoEm: sp('2037-10-02T09:00:00'),
    provedor: 'stripe',
  });
  // Devolução Inter ainda em processamento: o ledger não foi cancelado.
  const interPendente = await seed.pagamento({
    campaignId: base.campanha,
    taxaCents: 100,
    criadoEm: sp('2037-10-01T12:00:00'),
    provedor: 'inter',
  });
  await seed.devolucaoInter({
    idPagamento: interPendente.idPagamento,
    amountCents: interPendente.pagoCents,
    status: 'em_processamento',
    criadoEm: sp('2037-10-04T12:00:00'),
  });
  return { ...base, interEstornado, stripeParcial, interPendente };
}

function metrica(registradoCents: number, canceladoCents: number) {
  return { registradoCents, canceladoCents, resultadoCents: registradoCents - canceladoCents };
}

describe('admin.receita.painel — Recebido no banco e Tarifas (Postgres real)', () => {
  it('valores exatos de meses, semanas e KPIs no cenário de outubro', async () => {
    const s = await seedPainel();
    const p = await caller().admin.receita.painel();

    expect(p.timezone).toBe('America/Sao_Paulo');
    expect(p.hoje).toBe('2037-10-05');
    expect(p.janela).toEqual({ de: '2036-11-01', ate: '2037-11-01' });

    // Recebido: cada pagamento soma presente + taxa + adicional.
    expect(s.viradaSetembro.pagoCents).toBe(7_700);
    expect(s.stripeParcial.pagoCents).toBe(9_830);
    const recOutReg = 3_300 + 2_200 + 550 + 9_830 + 1_100;
    const recOutCanc = 11_000 + 8_400; // Stripe de agosto + Inter de 30/09

    // ── 12 meses, cronológicos, só o corrente parcial ──
    expect(p.meses).toHaveLength(12);
    expect(p.meses[0]?.de).toBe('2036-11-01');
    expect(p.meses.map((m) => m.parcial)).toEqual([...Array(11).fill(false), true]);
    const porMes = new Map(p.meses.map((m) => [m.de, m]));
    expect(porMes.get('2037-08-01')).toMatchObject({
      tarifas: metrica(1_000, 0),
      recebido: metrica(11_000, 0),
    });
    // 30/09 23:59 e 23:30 SP ficam em setembro (UTC já é 01/10).
    expect(porMes.get('2037-09-01')).toMatchObject({
      tarifas: metrica(700 + 400, 0),
      recebido: metrica(7_700 + 8_400, 0),
    });
    // Cancelamentos contam no mês em que ocorreram, não no do pagamento.
    expect(porMes.get('2037-10-01')).toMatchObject({
      tarifas: metrica(300 + 200 + 50 + 450 + 100, 1_000 + 400),
      recebido: metrica(recOutReg, recOutCanc),
    });
    for (const m of p.meses.slice(0, 9)) {
      expect(m.tarifas).toEqual(metrica(0, 0));
      expect(m.recebido).toEqual(metrica(0, 0));
    }

    // ── Semanas do mês corrente, seg–dom, recortadas a outubro ──
    expect(p.semanas.map((w) => [w.de, w.ate, w.estado])).toEqual([
      ['2037-10-01', '2037-10-05', 'passada'],
      ['2037-10-05', '2037-10-12', 'atual'],
      ['2037-10-12', '2037-10-19', 'futura'],
      ['2037-10-19', '2037-10-26', 'futura'],
      ['2037-10-26', '2037-11-01', 'futura'],
    ]);
    // 01–04/10 não inclui 30/09 23:59 (é a mesma semana ISO, mas outro mês).
    expect(p.semanas[0]).toMatchObject({
      tarifas: metrica(300 + 200 + 450 + 100, 1_400),
      recebido: metrica(3_300 + 2_200 + 9_830 + 1_100, recOutCanc),
    });
    expect(p.semanas[1]).toMatchObject({ tarifas: metrica(50, 0), recebido: metrica(550, 0) });
    for (const w of p.semanas.slice(2)) {
      expect(w.tarifas).toEqual(metrica(0, 0));
      expect(w.recebido).toEqual(metrica(0, 0));
    }

    // ── KPIs: semanas inteiras seg–dom; mês atual até hoje ──
    expect(p.kpis.mesAtual).toMatchObject({
      de: '2037-10-01',
      ate: '2037-10-06',
      tarifas: metrica(1_100, 1_400),
      recebido: metrica(recOutReg, recOutCanc),
    });
    expect(p.kpis.mesAnterior).toMatchObject({
      de: '2037-09-01',
      ate: '2037-10-01',
      tarifas: metrica(1_100, 0),
      recebido: metrica(16_100, 0),
    });
    expect(p.kpis.semanaAtual).toMatchObject({
      de: '2037-10-05',
      ate: '2037-10-12',
      tarifas: metrica(50, 0),
      recebido: metrica(550, 0),
    });
    // Semana anterior atravessa o mês: 28/09–04/10 inclui as viradas de setembro.
    expect(p.kpis.semanaAnterior).toMatchObject({
      de: '2037-09-28',
      ate: '2037-10-05',
      tarifas: metrica(700 + 400 + 1_050, 1_400),
      recebido: metrica(7_700 + 8_400 + 16_430, recOutCanc),
    });

    expect(p.diferencaConciliacao).toEqual({
      tarifas: { registradoCents: 0, canceladoCents: 0 },
      recebido: { registradoCents: 0, canceladoCents: 0 },
    });
    expect(p.inconsistencias).toEqual({
      estornadoSemCancelamento: { count: 0, cents: 0 },
      canceladoSemEstorno: { count: 0, cents: 0 },
    });
  });

  it('Tarifas do painel = resultado de taxas do dashboard existente em cada mês e semana', async () => {
    await seedPainel();
    const c = caller();
    const p = await c.admin.receita.painel();
    const intervalos = [
      ...p.meses,
      ...p.semanas,
      p.kpis.mesAtual,
      p.kpis.mesAnterior,
      p.kpis.semanaAtual,
      p.kpis.semanaAnterior,
    ];
    for (const i of intervalos) {
      const d = await c.admin.receita.dashboard({ de: i.de, ate: i.ate, granularidade: 'mes' });
      expect(i.tarifas, `${i.de}→${i.ate}`).toEqual({
        registradoCents: d.cards.periodo.taxasRegistradasCents,
        canceladoCents: d.cards.periodo.cancelamentosCents,
        resultadoCents: d.cards.periodo.resultadoDeTaxasCents,
      });
    }
  });

  it('mês atual é parcial: pagamento datado depois de hoje não entra no KPI do mês', async () => {
    const campanha = await seed.campanha();
    await seed.pagamento({
      campaignId: campanha,
      taxaCents: 80,
      criadoEm: sp('2037-10-05T23:59:00'),
    });
    await seed.pagamento({
      campaignId: campanha,
      taxaCents: 30,
      criadoEm: sp('2037-10-06T00:00:00'),
    });
    const p = await caller().admin.receita.painel();
    expect(p.kpis.mesAtual).toMatchObject({ ate: '2037-10-06', tarifas: metrica(80, 0) });
  });

  it('pagamento de outra plataforma não entra em nenhum número', async () => {
    const outra = await seed.campanha(OTHER_PLATFORM);
    await seed.pagamento({
      campaignId: outra,
      taxaCents: 999,
      criadoEm: sp('2037-10-05T09:00:00'),
    });
    await seed.pagamento({
      campaignId: outra,
      taxaCents: 999,
      criadoEm: sp('2037-09-15T09:00:00'),
    });
    const p = await caller().admin.receita.painel();
    for (const i of [...p.meses, ...p.semanas, ...Object.values(p.kpis)]) {
      expect(i.tarifas).toEqual(metrica(0, 0));
      expect(i.recebido).toEqual(metrica(0, 0));
    }
  });

  it('inconsistências: estornado sem cancelamento e cancelado sem estorno aparecem', async () => {
    const campanha = await seed.campanha();
    await seed.pagamento({
      campaignId: campanha,
      taxaCents: 210,
      criadoEm: sp('2037-10-02T10:00:00'),
      status: 'estornado',
    });
    await seed.pagamento({
      campaignId: campanha,
      taxaCents: 130,
      criadoEm: sp('2037-09-02T10:00:00'),
      canceladoEm: sp('2037-10-02T10:00:00'),
      status: 'aprovado',
    });
    const p = await caller().admin.receita.painel();
    expect(p.inconsistencias).toEqual({
      estornadoSemCancelamento: { count: 1, cents: 210 },
      canceladoSemEstorno: { count: 1, cents: 130 },
    });
  });

  it('bloqueia sem sessão (UNAUTHORIZED) e fora da allowlist (FORBIDDEN)', async () => {
    await expect(caller({ sessao: false }).admin.receita.painel()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      caller({ allowlist: ['outra-pessoa@example.com'] }).admin.receita.painel(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
