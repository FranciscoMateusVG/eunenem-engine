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
