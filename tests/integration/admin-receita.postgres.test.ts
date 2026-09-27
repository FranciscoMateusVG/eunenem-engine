import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadCampaignAdministrators } from '../../apps/eunenem-server/server/admin-campaign-administrators.js';
import {
  InvalidReceitaCampanhasCursorError,
  InvalidReceitaPeriodoError,
  listReceitaCampanhas,
  loadReceitaDashboard,
} from '../../apps/eunenem-server/server/admin-receita.js';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import type { Database } from '../../src/adapters/database.js';
import type { DB } from '../../src/adapters/db-types.generated.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * aperture-9bpre — Receita EuNeném contra Postgres real (Testcontainers).
 *
 * Todas as datas ficam em 2031: o container é compartilhado entre arquivos e
 * outras suítes podem deixar linhas de taxa na plataforma. Períodos distantes
 * mantêm os números deste arquivo independentes desse resíduo.
 *
 * Matriz (contrato 9bpre v1 + v2):
 *   T1  jan 100 / estorno em fev ⇒ jan 100, fev −100, jan+fev 0
 *   T2  nenhuma fórmula depende de pagamentos.status
 *   T3  borda de fuso (mês) e borda domingo/segunda (semana) em São Paulo
 *   T4  adicional de cartão fora da receita
 *   T5  coadmins não duplicam a campanha
 *   T6  101 campanhas: totais independem do limite da lista
 *   T7  provedor ausente ⇒ bucket nao_registrado, conciliação fecha
 *   T8  total independente = série = por campanha = por meio/provedor
 *   T9/T17 outra plataforma e linha sem pagamento resolvível: nenhum número
 *   T10 inconsistências no escopo, recortadas pelo período
 *   T11 snapshot único + transação somente leitura
 *   T12/T13/T18 administradores: exibição limitada, elegibilidade na totalidade
 *   T16 drilldown paginado com snapshot distinto declarado
 */

const OTHER_PLATFORM = '00000000-0000-4000-8000-00000000f9b1';
const CURSOR_SECRET = 'admin-receita-integration-cursor-secret';
const NOW = new Date('2031-06-18T15:00:00.000Z'); // quarta-feira em SP

let testDb: TestDatabase;

const seeded = {
  campaigns: new Set<string>(),
  users: new Set<string>(),
  lancamentos: new Set<string>(),
};

// biome-ignore lint/suspicious/noExplicitAny: fixtures cruzam vários BCs
const anyDb = () => testDb.db as any;

async function wipe(): Promise<void> {
  const db = anyDb();
  const lancamentos = [...seeded.lancamentos];
  const campaigns = [...seeded.campaigns];
  const users = [...seeded.users];
  if (lancamentos.length > 0) {
    await db.deleteFrom('lancamentos_financeiros').where('id', 'in', lancamentos).execute();
  }
  if (campaigns.length > 0) {
    const pagamentos = db
      .selectFrom('pagamentos')
      .select('id')
      .where('intencao_id_campanha', 'in', campaigns);
    await db.deleteFrom('intencao_items').where('id_pagamento', 'in', pagamentos).execute();
    await db.deleteFrom('pagamentos').where('intencao_id_campanha', 'in', campaigns).execute();
    await db.deleteFrom('contribuicoes').where('campanha_id', 'in', campaigns).execute();
    await db.deleteFrom('opcoes_contribuicao').where('campanha_id', 'in', campaigns).execute();
    await db.deleteFrom('campanha_administradores').where('campanha_id', 'in', campaigns).execute();
    await db.deleteFrom('campanhas').where('id', 'in', campaigns).execute();
  }
  if (users.length > 0) {
    await db.deleteFrom('usuarios').where('id', 'in', users).execute();
  }
  seeded.lancamentos.clear();
  seeded.campaigns.clear();
  seeded.users.clear();
}

async function seedCampanha(
  input: { id?: string; platformId?: string; titulo?: string; slug?: string | null } = {},
): Promise<string> {
  const id = input.id ?? randomUUID();
  await anyDb()
    .insertInto('campanhas')
    .values({
      id,
      id_plataforma: input.platformId ?? ID_PLATAFORMA_EUNENEM,
      titulo: input.titulo ?? `Campanha ${id.slice(0, 8)}`,
      slug: input.slug ?? null,
    })
    .execute();
  seeded.campaigns.add(id);
  return id;
}

async function seedUsuario(input: {
  idConta: string;
  slug: string;
  nome?: string;
  platformId?: string;
}): Promise<void> {
  const id = randomUUID();
  await anyDb()
    .insertInto('usuarios')
    .values({
      id,
      id_plataforma: input.platformId ?? ID_PLATAFORMA_EUNENEM,
      id_conta: input.idConta,
      email: `${input.slug}@receita.test`,
      nome_exibicao: input.nome ?? `Pessoa ${input.slug}`,
      slug: input.slug,
    })
    .execute();
  seeded.users.add(id);
}

async function seedAdministrador(campaignId: string, idConta: string): Promise<void> {
  await anyDb()
    .insertInto('campanha_administradores')
    .values({ campanha_id: campaignId, id_usuario: idConta })
    .execute();
}

interface TaxaSeed {
  readonly campaignId: string;
  readonly taxaCents: number;
  readonly criadoEm: Date;
  readonly canceladoEm?: Date | null;
  readonly status?: 'aprovado' | 'estornado' | 'pendente' | 'rejeitado';
  readonly metodo?: 'pix' | 'credit_card';
  readonly provedor?: 'stripe' | 'inter' | null;
  /** Adicional de cartão (item + lançamento próprios). */
  readonly adicionalCents?: number;
  /** Sobrescreve o pagamento referenciado pela linha de taxa (linha órfã). */
  readonly idPagamentoDaLinha?: string;
}

async function seedTaxa(input: TaxaSeed): Promise<{ idPagamento: string; idLancamento: string }> {
  const db = anyDb();
  const idPagamento = randomUUID();
  const idContribuicao = randomUUID();
  const idItem = randomUUID();
  const idLancamento = randomUUID();
  const provedor = input.provedor === undefined ? 'stripe' : input.provedor;
  // Composição válida para o agregado Pagamento: taxa cobrada sobre o presente.
  const contribuicaoCents = input.taxaCents * 10;
  // TransacaoExterna completa (o agregado exige status, valor e data).
  const transacaoExterna =
    provedor === null
      ? null
      : JSON.stringify({
          id: `ext-${idPagamento}`,
          provedor,
          status: 'aprovado',
          amountCents: contribuicaoCents + input.taxaCents + (input.adicionalCents ?? 0),
          criadaEm: input.criadoEm.toISOString(),
          statusBruto: 'paid',
        });
  const metodo = input.metodo ?? 'pix';

  await db
    .insertInto('opcoes_contribuicao')
    .values({ id: idContribuicao, campanha_id: input.campaignId, tipo: 'presente' })
    .execute();
  await db
    .insertInto('contribuicoes')
    .values({
      id: idContribuicao,
      campanha_id: input.campaignId,
      id_opcao_contribuicao: idContribuicao,
      nome: 'presente sintético',
      valor: contribuicaoCents,
    })
    .execute();
  await sql`
    INSERT INTO pagamentos (
      id, status, criado_em, atualizado_em, intencao_id, intencao_id_campanha,
      intencao_metodo, intencao_criada_em,
      intencao_total_contribution_cents, intencao_total_fee_cents,
      intencao_total_receiver_cents, intencao_total_surcharge_cents,
      intencao_total_paid_cents, transacao_externa
    ) VALUES (
      ${idPagamento}::uuid, ${input.status ?? 'aprovado'}, ${input.criadoEm}, ${input.criadoEm},
      ${randomUUID()}::uuid, ${input.campaignId}::uuid,
      ${metodo}, ${input.criadoEm},
      ${contribuicaoCents}, ${input.taxaCents}, ${contribuicaoCents},
      ${input.adicionalCents ?? 0},
      ${contribuicaoCents + input.taxaCents + (input.adicionalCents ?? 0)},
      ${transacaoExterna}::jsonb
    )
  `.execute(testDb.db);
  await db
    .insertInto('intencao_items')
    .values({
      id: idItem,
      id_pagamento: idPagamento,
      id_intencao_pagamento: idPagamento,
      position: 0,
      tipo: 'contribuicao',
      id_contribuicao: idContribuicao,
      quantidade: 1,
      contribution_unit_amount_cents: contribuicaoCents,
      fee_unit_amount_cents: input.taxaCents,
      receiver_unit_amount_cents: contribuicaoCents,
      line_contribution_amount_cents: contribuicaoCents,
      line_fee_amount_cents: input.taxaCents,
      line_receiver_amount_cents: contribuicaoCents,
      surcharge_amount_cents: null,
      criado_em: input.criadoEm,
    })
    .execute();
  await db
    .insertInto('lancamentos_financeiros')
    .values({
      id: idLancamento,
      id_pagamento: input.idPagamentoDaLinha ?? idPagamento,
      id_item_pagamento: idItem,
      id_contribuicao: idContribuicao,
      // Convenção: a linha de receita NÃO carrega id_campanha.
      id_campanha: null,
      tipo: 'credito_receita_plataforma',
      amount_cents: input.taxaCents,
      criado_em: input.criadoEm,
      transferido_em: null,
      cancelado_em: input.canceladoEm ?? null,
      id_repasse: null,
    })
    .execute();
  seeded.lancamentos.add(idLancamento);

  if (input.adicionalCents !== undefined) {
    const idItemAdicional = randomUUID();
    const idAdicional = randomUUID();
    await db
      .insertInto('intencao_items')
      .values({
        id: idItemAdicional,
        id_pagamento: idPagamento,
        id_intencao_pagamento: idPagamento,
        position: 1,
        tipo: 'passthrough_surcharge',
        id_contribuicao: null,
        quantidade: 1,
        contribution_unit_amount_cents: null,
        fee_unit_amount_cents: null,
        receiver_unit_amount_cents: null,
        line_contribution_amount_cents: null,
        line_fee_amount_cents: null,
        line_receiver_amount_cents: null,
        surcharge_amount_cents: input.adicionalCents,
        criado_em: input.criadoEm,
      })
      .execute();
    await db
      .insertInto('lancamentos_financeiros')
      .values({
        id: idAdicional,
        id_pagamento: idPagamento,
        id_item_pagamento: idItemAdicional,
        id_contribuicao: idContribuicao,
        id_campanha: input.campaignId,
        tipo: 'credito_passthrough_surcharge',
        amount_cents: input.adicionalCents,
        criado_em: input.criadoEm,
        transferido_em: null,
        cancelado_em: input.canceladoEm ?? null,
        id_repasse: null,
      })
      .execute();
    seeded.lancamentos.add(idAdicional);
  }
  return { idPagamento, idLancamento };
}

function dashboard(
  periodo: { de: string; ate: string; granularidade: 'semana' | 'mes' },
  db: Database = testDb.db,
) {
  return loadReceitaDashboard(db, {
    platformId: ID_PLATAFORMA_EUNENEM,
    periodo,
    now: NOW,
  });
}

const ZERO = { taxasRegistradasCents: 0, cancelamentosCents: 0 };

function expectConciliado(d: Awaited<ReturnType<typeof dashboard>>) {
  expect(d.conciliacao.somaSerie).toEqual(d.conciliacao.totalIndependente);
  expect(d.conciliacao.somaPorCampanha).toEqual(d.conciliacao.totalIndependente);
  expect(d.conciliacao.somaPorMeioProvedor).toEqual(d.conciliacao.totalIndependente);
  expect(d.conciliacao.diferencas).toEqual({
    serie: ZERO,
    porCampanha: ZERO,
    porMeioProvedor: ZERO,
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

beforeEach(async () => {
  await wipe();
});

afterAll(async () => {
  await wipe();
  await testDb.teardown();
});

describe('Receita EuNeném — eventos E', () => {
  it('T1: taxa de janeiro estornada em fevereiro não reescreve janeiro', async () => {
    const campanha = await seedCampanha();
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 100,
      criadoEm: new Date('2031-01-15T15:00:00Z'),
      canceladoEm: new Date('2031-02-10T15:00:00Z'),
      status: 'estornado',
    });

    const jan = await dashboard({ de: '2031-01-01', ate: '2031-02-01', granularidade: 'mes' });
    expect(jan.cards.periodo).toMatchObject({
      taxasRegistradasCents: 100,
      cancelamentosCents: 0,
      resultadoDeTaxasCents: 100,
      lancamentosRegistrados: 1,
      lancamentosCancelados: 0,
      pagamentosComTaxa: 1,
    });

    const fev = await dashboard({ de: '2031-02-01', ate: '2031-03-01', granularidade: 'mes' });
    expect(fev.cards.periodo).toMatchObject({
      taxasRegistradasCents: 0,
      cancelamentosCents: 100,
      resultadoDeTaxasCents: -100,
      lancamentosRegistrados: 0,
      lancamentosCancelados: 1,
    });

    const ambos = await dashboard({ de: '2031-01-01', ate: '2031-03-01', granularidade: 'mes' });
    expect(ambos.cards.periodo).toMatchObject({
      taxasRegistradasCents: 100,
      cancelamentosCents: 100,
      resultadoDeTaxasCents: 0,
    });
    expect(ambos.serie).toEqual([
      {
        inicio: '2031-01-01',
        fim: '2031-02-01',
        parcial: false,
        taxasRegistradasCents: 100,
        cancelamentosCents: 0,
        resultadoDeTaxasCents: 100,
      },
      {
        inicio: '2031-02-01',
        fim: '2031-03-01',
        parcial: false,
        taxasRegistradasCents: 0,
        cancelamentosCents: 100,
        resultadoDeTaxasCents: -100,
      },
    ]);
    for (const d of [jan, fev, ambos]) expectConciliado(d);
    // Estorno coerente (estornado + cancelado_em) não é inconsistência.
    expect(ambos.inconsistencias).toEqual({
      estornadoSemCancelamento: { count: 0, cents: 0 },
      canceladoSemEstorno: { count: 0, cents: 0 },
    });
  });

  it('T2: o status atual do pagamento não altera nenhuma fórmula', async () => {
    const campanha = await seedCampanha();
    const { idPagamento } = await seedTaxa({
      campaignId: campanha,
      taxaCents: 250,
      criadoEm: new Date('2031-01-15T15:00:00Z'),
      canceladoEm: new Date('2031-02-10T15:00:00Z'),
      status: 'estornado',
    });
    const periodo = { de: '2031-01-01', ate: '2031-03-01', granularidade: 'mes' } as const;
    const antes = await dashboard(periodo);

    for (const status of ['aprovado', 'pendente', 'rejeitado'] as const) {
      await anyDb()
        .updateTable('pagamentos')
        .set({ status })
        .where('id', '=', idPagamento)
        .execute();
      const depois = await dashboard(periodo);
      expect(depois.cards.periodo).toEqual(antes.cards.periodo);
      expect(depois.serie).toEqual(antes.serie);
      expect(depois.porCampanha).toEqual(antes.porCampanha);
      expect(depois.porMeioProvedor).toEqual(antes.porMeioProvedor);
      expect(depois.conciliacao).toEqual(antes.conciliacao);
      // O status só aparece aqui, fora dos totais.
      expect(depois.inconsistencias.canceladoSemEstorno).toEqual({ count: 1, cents: 250 });
    }
  });

  it('T3: cortes em America/Sao_Paulo — borda de mês e borda domingo/segunda', async () => {
    const campanha = await seedCampanha();
    // 2031-03-01T02:30Z = 28/02 23:30 em SP ⇒ fevereiro.
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 11,
      criadoEm: new Date('2031-03-01T02:30:00Z'),
    });
    // 2031-03-01T03:00Z = 01/03 00:00 em SP ⇒ março.
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 13,
      criadoEm: new Date('2031-03-01T03:00:00Z'),
    });
    const fev = await dashboard({ de: '2031-02-01', ate: '2031-03-01', granularidade: 'mes' });
    const mar = await dashboard({ de: '2031-03-01', ate: '2031-04-01', granularidade: 'mes' });
    expect(fev.cards.periodo.taxasRegistradasCents).toBe(11);
    expect(mar.cards.periodo.taxasRegistradasCents).toBe(13);

    await wipe();
    const outra = await seedCampanha();
    // 2031-03-03 é segunda-feira. 02:30Z ainda é domingo 02/03 23:30 em SP.
    await seedTaxa({
      campaignId: outra,
      taxaCents: 17,
      criadoEm: new Date('2031-03-03T02:30:00Z'),
    });
    await seedTaxa({
      campaignId: outra,
      taxaCents: 19,
      criadoEm: new Date('2031-03-03T03:00:00Z'),
    });
    const semanas = await dashboard({
      de: '2031-02-24',
      ate: '2031-03-10',
      granularidade: 'semana',
    });
    expect(semanas.serie.map((b) => [b.inicio, b.fim, b.parcial, b.taxasRegistradasCents])).toEqual(
      [
        ['2031-02-24', '2031-03-03', false, 17],
        ['2031-03-03', '2031-03-10', false, 19],
      ],
    );
    expectConciliado(semanas);
  });

  it('T4: adicional de cartão fica em bloco próprio, fora da receita', async () => {
    const campanha = await seedCampanha();
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 100,
      adicionalCents: 70,
      metodo: 'credit_card',
      criadoEm: new Date('2031-04-10T15:00:00Z'),
      canceladoEm: new Date('2031-04-20T15:00:00Z'),
      status: 'estornado',
    });
    const d = await dashboard({ de: '2031-04-01', ate: '2031-05-01', granularidade: 'mes' });
    expect(d.cards.periodo).toMatchObject({
      taxasRegistradasCents: 100,
      cancelamentosCents: 100,
      resultadoDeTaxasCents: 0,
      adicionalCartao: { registradoCents: 70, canceladoCents: 70 },
    });
    expect(d.serie.map((b) => b.taxasRegistradasCents)).toEqual([100]);
    expect(d.porCampanha.rows.map((c) => c.taxasRegistradasCents)).toEqual([100]);
    expect(d.porMeioProvedor).toEqual([
      {
        metodo: 'credit_card',
        provedor: 'stripe',
        taxasRegistradasCents: 100,
        cancelamentosCents: 100,
        resultadoDeTaxasCents: 0,
      },
    ]);
    expectConciliado(d);
  });

  it('T5: campanha com dois coadmins conta uma vez', async () => {
    const campanha = await seedCampanha({ slug: 'cha-da-lia' });
    const contaA = '12000000-0000-4000-8000-00000000b001';
    const contaB = '12000000-0000-4000-8000-00000000b002';
    await seedUsuario({ idConta: contaA, slug: 'ana-receita' });
    await seedUsuario({ idConta: contaB, slug: 'bia-receita' });
    await seedAdministrador(campanha, contaA);
    await seedAdministrador(campanha, contaB);
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 300,
      criadoEm: new Date('2031-05-05T15:00:00Z'),
    });

    const d = await dashboard({ de: '2031-05-01', ate: '2031-06-01', granularidade: 'mes' });
    expect(d.cards.periodo.taxasRegistradasCents).toBe(300);
    expect(d.porCampanha.campanhasTotal).toBe(1);
    expect(d.porCampanha.rows).toHaveLength(1);
    expect(d.porCampanha.rows[0]).toMatchObject({
      idCampanha: campanha,
      campaignSlug: 'cha-da-lia',
      taxasRegistradasCents: 300,
    });
    expect(d.porCampanha.rows[0]?.administrators.total).toBe(2);
    expect(d.porCampanha.rows[0]?.administrators.rows.map((a) => a.idConta)).toEqual([
      contaA,
      contaB,
    ]);
    expect(d.porCampanha.rows[0]?.administrators.publicOwnerSlug).toBe('ana-receita');
    expectConciliado(d);
  });

  it('T7: provedor ausente vira bucket nao_registrado e a conciliação fecha', async () => {
    const campanha = await seedCampanha();
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 40,
      provedor: null,
      criadoEm: new Date('2031-07-05T15:00:00Z'),
    });
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 60,
      provedor: 'inter',
      criadoEm: new Date('2031-07-06T15:00:00Z'),
    });
    const d = await dashboard({ de: '2031-07-01', ate: '2031-08-01', granularidade: 'mes' });
    expect(d.porMeioProvedor).toEqual([
      {
        metodo: 'pix',
        provedor: 'inter',
        taxasRegistradasCents: 60,
        cancelamentosCents: 0,
        resultadoDeTaxasCents: 60,
      },
      {
        metodo: 'pix',
        provedor: 'nao_registrado',
        taxasRegistradasCents: 40,
        cancelamentosCents: 0,
        resultadoDeTaxasCents: 40,
      },
    ]);
    expect(d.cards.periodo.taxasRegistradasCents).toBe(100);
    expectConciliado(d);
  });

  it('T9/T17: outra plataforma e linha sem pagamento resolvível não geram número', async () => {
    const nossa = await seedCampanha();
    const alheia = await seedCampanha({ platformId: OTHER_PLATFORM });
    await seedTaxa({
      campaignId: nossa,
      taxaCents: 500,
      criadoEm: new Date('2031-08-05T15:00:00Z'),
    });
    // Outra plataforma: estornado sem cancelado_em seria "inconsistência".
    await seedTaxa({
      campaignId: alheia,
      taxaCents: 9_000,
      adicionalCents: 800,
      status: 'estornado',
      criadoEm: new Date('2031-08-06T15:00:00Z'),
    });
    // Linha cuja referência de pagamento não resolve para pagamento algum.
    await seedTaxa({
      campaignId: nossa,
      taxaCents: 7_000,
      criadoEm: new Date('2031-08-07T15:00:00Z'),
      idPagamentoDaLinha: randomUUID(),
    });

    const d = await dashboard({ de: '2031-08-01', ate: '2031-09-01', granularidade: 'mes' });
    expect(d.cards.periodo).toMatchObject({
      taxasRegistradasCents: 500,
      cancelamentosCents: 0,
      resultadoDeTaxasCents: 500,
      lancamentosRegistrados: 1,
      pagamentosComTaxa: 1,
      adicionalCartao: { registradoCents: 0, canceladoCents: 0 },
    });
    expect(d.porCampanha.campanhasTotal).toBe(1);
    expect(d.porCampanha.rows.map((c) => c.idCampanha)).toEqual([nossa]);
    expect(d.inconsistencias).toEqual({
      estornadoSemCancelamento: { count: 0, cents: 0 },
      canceladoSemEstorno: { count: 0, cents: 0 },
    });
    expectConciliado(d);

    const pagina = await listReceitaCampanhas(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      de: '2031-08-01',
      ate: '2031-09-01',
      cursor: null,
      limit: 50,
      cursorSecret: CURSOR_SECRET,
    });
    expect(pagina.rows.map((c) => c.idCampanha)).toEqual([nossa]);
    expect(pagina.campanhasTotal).toBe(1);
  });

  it('T10: inconsistências ficam no escopo e são recortadas pelo período', async () => {
    const campanha = await seedCampanha();
    // Dentro do período: estornado sem cancelado_em.
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 120,
      status: 'estornado',
      criadoEm: new Date('2031-09-05T15:00:00Z'),
    });
    // Criada fora, cancelada dentro, pagamento não estornado.
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 80,
      status: 'aprovado',
      criadoEm: new Date('2031-08-20T15:00:00Z'),
      canceladoEm: new Date('2031-09-10T15:00:00Z'),
    });
    // Inteiramente fora do período.
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 999,
      status: 'estornado',
      criadoEm: new Date('2031-11-05T15:00:00Z'),
    });

    const d = await dashboard({ de: '2031-09-01', ate: '2031-10-01', granularidade: 'mes' });
    expect(d.inconsistencias).toEqual({
      estornadoSemCancelamento: { count: 1, cents: 120 },
      canceladoSemEstorno: { count: 1, cents: 80 },
    });
    // Inconsistência é exibida à parte; não ajusta nenhum total.
    expect(d.cards.periodo).toMatchObject({
      taxasRegistradasCents: 120,
      cancelamentosCents: 80,
      resultadoDeTaxasCents: 40,
    });
    expectConciliado(d);
  });

  it('período sem taxa devolve zeros de fato e série completa', async () => {
    const d = await dashboard({ de: '2032-01-01', ate: '2032-04-01', granularidade: 'mes' });
    expect(d.cards.periodo).toMatchObject({
      taxasRegistradasCents: 0,
      cancelamentosCents: 0,
      resultadoDeTaxasCents: 0,
      lancamentosRegistrados: 0,
    });
    expect(d.serie.map((b) => b.inicio)).toEqual(['2032-01-01', '2032-02-01', '2032-03-01']);
    expect(d.porCampanha).toEqual({
      rows: [],
      campanhasTotal: 0,
      truncated: false,
      foraDaLista: ZERO,
    });
    expect(d.porMeioProvedor).toEqual([]);
    expectConciliado(d);
  });

  it('período parcial marca o bucket e cards atuais usam semana/mês de São Paulo', async () => {
    const campanha = await seedCampanha();
    // NOW = quarta 18/06/2031. Semana ISO: 16/06–23/06. Mês: junho.
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 21,
      criadoEm: new Date('2031-06-16T03:00:00Z'), // segunda 00:00 SP
    });
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 34,
      criadoEm: new Date('2031-06-02T15:00:00Z'), // mesmo mês, outra semana
    });
    const d = await dashboard({ de: '2031-06-10', ate: '2031-06-20', granularidade: 'mes' });
    expect(d.serie).toHaveLength(1);
    expect(d.serie[0]).toMatchObject({
      inicio: '2031-06-01',
      fim: '2031-07-01',
      parcial: true,
      taxasRegistradasCents: 21,
    });
    expect(d.cards.semanaAtual).toMatchObject({
      de: '2031-06-16',
      ate: '2031-06-23',
      taxasRegistradasCents: 21,
    });
    expect(d.cards.mesAtual).toMatchObject({
      de: '2031-06-01',
      ate: '2031-07-01',
      taxasRegistradasCents: 55,
    });
    expect(d.primeiroRegistroTaxaEm).not.toBeNull();
    expect(d.primeiroRegistroTaxaEm?.getTime()).toBeLessThanOrEqual(
      new Date('2031-06-02T15:00:00Z').getTime(),
    );
    expectConciliado(d);
  });

  it('período inválido é rejeitado antes de qualquer leitura', async () => {
    await expect(
      dashboard({ de: '2031-02-01', ate: '2031-02-01', granularidade: 'mes' }),
    ).rejects.toBeInstanceOf(InvalidReceitaPeriodoError);
    await expect(
      dashboard({ de: '2031-02-30', ate: '2031-03-01', granularidade: 'mes' }),
    ).rejects.toBeInstanceOf(InvalidReceitaPeriodoError);
    await expect(
      dashboard({ de: '2020-01-01', ate: '2031-03-01', granularidade: 'semana' }),
    ).rejects.toBeInstanceOf(InvalidReceitaPeriodoError);
  });
});

describe('Receita EuNeném — limites da lista e drilldown', () => {
  const PERIODO = { de: '2031-10-01', ate: '2031-11-01', granularidade: 'mes' } as const;
  let ids: string[] = [];

  async function seed101() {
    ids = [];
    for (let i = 0; i < 101; i++) {
      const suffix = String(i).padStart(12, '0');
      const id = await seedCampanha({
        id: `10000000-0000-4000-8000-${suffix}`,
        titulo: `Campanha ${i}`,
      });
      ids.push(id);
      // Valores distintos, exceto um empate (i=0 e i=1) para exercitar o
      // desempate por id.
      await seedTaxa({
        campaignId: id,
        taxaCents: i <= 1 ? 1_000 : 1_000 + i,
        criadoEm: new Date('2031-10-10T15:00:00Z'),
        canceladoEm: i === 50 ? new Date('2031-10-12T15:00:00Z') : null,
        status: i === 50 ? 'estornado' : 'aprovado',
      });
    }
  }

  it('T6: 101 campanhas — totais não dependem do limite da lista', async () => {
    await seed101();
    const total =
      1_000 * 2 + Array.from({ length: 99 }, (_, k) => 1_000 + k + 2).reduce((a, b) => a + b, 0);
    const d = await dashboard(PERIODO);
    expect(d.cards.periodo.taxasRegistradasCents).toBe(total);
    expect(d.cards.periodo.cancelamentosCents).toBe(1_050);
    expect(d.cards.periodo.pagamentosComTaxa).toBe(101);
    expect(d.porCampanha.rows).toHaveLength(100);
    expect(d.porCampanha.campanhasTotal).toBe(101);
    expect(d.porCampanha.truncated).toBe(true);
    // Ordem registradas DESC, id ASC ⇒ fica de fora o empate de maior id (i=1).
    expect(d.porCampanha.foraDaLista).toEqual({
      taxasRegistradasCents: 1_000,
      cancelamentosCents: 0,
    });
    expect(d.porCampanha.rows.some((c) => c.idCampanha === ids[1])).toBe(false);
    expect(d.porCampanha.rows.at(-1)?.idCampanha).toBe(ids[0]);
    expectConciliado(d);
  }, 120_000);

  it('T16: drilldown pagina todas as campanhas sem perder nem duplicar', async () => {
    await seed101();
    const vistos: string[] = [];
    const valores: number[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    let primeiroCursor: string | null = null;
    do {
      const pagina = await listReceitaCampanhas(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        de: PERIODO.de,
        ate: PERIODO.ate,
        cursor,
        limit: 40,
        cursorSecret: CURSOR_SECRET,
      });
      expect(pagina.consistencia).toBe('snapshot_distinto');
      expect(pagina.campanhasTotal).toBe(101);
      expect(pagina.snapshotAt).toBeInstanceOf(Date);
      for (const row of pagina.rows) {
        vistos.push(row.idCampanha);
        valores.push(row.taxasRegistradasCents);
      }
      cursor = pagina.nextCursor;
      primeiroCursor ??= cursor;
      paginas += 1;
    } while (cursor !== null && paginas < 10);

    expect(paginas).toBe(3);
    expect(vistos).toHaveLength(101);
    expect(new Set(vistos).size).toBe(101);
    expect([...vistos].sort()).toEqual([...ids].sort());
    expect(valores).toEqual([...valores].sort((a, b) => b - a));
    // Empate resolvido por id ASC.
    expect(vistos.slice(-2)).toEqual([ids[0], ids[1]]);

    if (primeiroCursor === null) throw new Error('cursor esperado');
    const adulterado = `${primeiroCursor.slice(0, -2)}xx`;
    await expect(
      listReceitaCampanhas(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        de: PERIODO.de,
        ate: PERIODO.ate,
        cursor: adulterado,
        limit: 40,
        cursorSecret: CURSOR_SECRET,
      }),
    ).rejects.toBeInstanceOf(InvalidReceitaCampanhasCursorError);
    // Cursor de outro período não vale para este.
    await expect(
      listReceitaCampanhas(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        de: '2031-10-02',
        ate: PERIODO.ate,
        cursor: primeiroCursor,
        limit: 40,
        cursorSecret: CURSOR_SECRET,
      }),
    ).rejects.toBeInstanceOf(InvalidReceitaCampanhasCursorError);
  }, 120_000);
});

describe('Receita EuNeném — snapshot único', () => {
  /**
   * Pool que executa um gancho DEPOIS da n-ésima consulta da conexão. Permite
   * commitar uma escrita concorrente, por outra conexão, exatamente entre
   * duas leituras internas do dashboard.
   */
  function databaseComGancho(depoisDaConsulta: number, gancho: () => Promise<void>) {
    const pool = new pg.Pool({ connectionString: testDb.connectionUri, max: 1 });
    let consultas = 0;
    const original = pool.connect.bind(pool);
    // biome-ignore lint/suspicious/noExplicitAny: envoltório mínimo do cliente pg
    (pool as any).connect = async () => {
      const client = await original();
      // biome-ignore lint/suspicious/noExplicitAny: idem
      const c = client as any;
      if (!c.__receitaWrapped) {
        const query = c.query.bind(c);
        c.query = async (...args: unknown[]) => {
          const result = await query(...args);
          consultas += 1;
          if (consultas === depoisDaConsulta) await gancho();
          return result;
        };
        c.__receitaWrapped = true;
      }
      return client;
    };
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    return { db, consultas: () => consultas };
  }

  it('T11: escrita commitada no meio da leitura não entra na resposta', async () => {
    const campanha = await seedCampanha();
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 100,
      criadoEm: new Date('2031-12-05T15:00:00Z'),
    });
    const periodo = { de: '2031-12-01', ate: '2032-01-01', granularidade: 'mes' } as const;

    let escreveu = false;
    // Consultas da conexão: 1 BEGIN, 2 SET TRANSACTION, 3 now(), 4 total do
    // período. O gancho roda logo após o total independente.
    const { db, consultas } = databaseComGancho(4, async () => {
      await seedTaxa({
        campaignId: campanha,
        taxaCents: 900,
        criadoEm: new Date('2031-12-06T15:00:00Z'),
      });
      escreveu = true;
    });
    try {
      const d = await dashboard(periodo, db);
      expect(escreveu).toBe(true);
      expect(consultas()).toBeGreaterThan(4);
      expect(d.cards.periodo.taxasRegistradasCents).toBe(100);
      expect(d.serie.map((b) => b.taxasRegistradasCents)).toEqual([100]);
      expect(d.porCampanha.rows.map((c) => c.taxasRegistradasCents)).toEqual([100]);
      expect(d.cards.mesAtual.taxasRegistradasCents).toBe(0);
      expectConciliado(d);
    } finally {
      await db.destroy();
    }

    // Uma leitura nova enxerga a escrita.
    const depois = await dashboard(periodo);
    expect(depois.cards.periodo.taxasRegistradasCents).toBe(1_000);
  });

  it('T11: a transação do dashboard é somente leitura', async () => {
    await expect(
      testDb.db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          await sql`SET TRANSACTION READ ONLY`.execute(trx);
          await sql`
            INSERT INTO campanhas (id, id_plataforma, titulo)
            VALUES (${randomUUID()}::uuid, ${ID_PLATAFORMA_EUNENEM}, 'não deve existir')
          `.execute(trx);
        }),
    ).rejects.toThrow(/read-only transaction/i);
  });
});

describe('Administradores da campanha', () => {
  const contas = Array.from({ length: 6 }, (_, i) => `12000000-0000-4000-8000-00000000c00${i + 1}`);

  it('T12: seis administradores e só o sexto elegível — link público existe', async () => {
    const campanha = await seedCampanha({ slug: 'seis-admins' });
    for (const conta of contas) await seedAdministrador(campanha, conta);
    await seedUsuario({ idConta: contas[5] as string, slug: 'sexta-pessoa' });

    const limitado = await loadCampaignAdministrators(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      campaignIds: [campanha],
      perCampaignLimit: 5,
    });
    const resumo = limitado.get(campanha);
    expect(resumo?.total).toBe(6);
    expect(resumo?.rows.map((a) => a.idConta)).toEqual(contas.slice(0, 5));
    expect(resumo?.rows.every((a) => !a.hasUserRow && a.displayName === null)).toBe(true);
    // A lista exibida não contém nenhum elegível; o slug vem da totalidade.
    expect(resumo?.publicOwnerSlug).toBe('sexta-pessoa');
  });

  it('T13: nenhum administrador elegível — sem slug público', async () => {
    const campanha = await seedCampanha();
    await seedAdministrador(campanha, contas[0] as string);
    // Usuário homônimo em OUTRA plataforma não torna a conta elegível.
    await seedUsuario({
      idConta: contas[0] as string,
      slug: 'fora-da-plataforma',
      platformId: OTHER_PLATFORM,
    });
    const resumo = (
      await loadCampaignAdministrators(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        campaignIds: [campanha],
        perCampaignLimit: 5,
      })
    ).get(campanha);
    expect(resumo).toEqual({
      rows: [{ idConta: contas[0], displayName: null, email: null, hasUserRow: false }],
      total: 1,
      publicOwnerSlug: null,
    });
  });

  it('elegível é o primeiro por id_conta, e campanha de outra plataforma não é lida', async () => {
    const campanha = await seedCampanha();
    const alheia = await seedCampanha({ platformId: OTHER_PLATFORM });
    for (const conta of contas.slice(0, 3)) await seedAdministrador(campanha, conta);
    await seedAdministrador(alheia, contas[0] as string);
    await seedUsuario({ idConta: contas[2] as string, slug: 'terceira' });
    await seedUsuario({ idConta: contas[1] as string, slug: 'segunda' });

    const lote = await loadCampaignAdministrators(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      campaignIds: [campanha, alheia, campanha],
      perCampaignLimit: 5,
    });
    expect(lote.has(alheia)).toBe(false);
    expect(lote.get(campanha)?.publicOwnerSlug).toBe('segunda');
    expect(lote.get(campanha)?.rows).toEqual([
      { idConta: contas[0], displayName: null, email: null, hasUserRow: false },
      {
        idConta: contas[1],
        displayName: 'Pessoa segunda',
        email: 'segunda@receita.test',
        hasUserRow: true,
      },
      {
        idConta: contas[2],
        displayName: 'Pessoa terceira',
        email: 'terceira@receita.test',
        hasUserRow: true,
      },
    ]);
  });
});

describe('admin.receita.* e admin.campanhas.findById pelo router', () => {
  function buildCaller(extra: Partial<ServerDeps> = {}) {
    const auth = adminAuthOverrides();
    const deps = {
      ...auth.depsOverrides,
      db: testDb.db,
      clock: () => NOW,
      logPiiHashSalt: CURSOR_SECRET,
      ...extra,
    } as unknown as ServerDeps;
    const ctx: TrpcContext = { deps, headers: auth.headers, resHeaders: new Headers() };
    return appRouter.createCaller(ctx);
  }

  it('dashboard devolve o DTO completo com limites de dados fixos', async () => {
    const campanha = await seedCampanha({ slug: 'cha-router' });
    const conta = '12000000-0000-4000-8000-00000000d001';
    await seedUsuario({ idConta: conta, slug: 'dona-router' });
    await seedAdministrador(campanha, conta);
    await seedTaxa({
      campaignId: campanha,
      taxaCents: 100,
      criadoEm: new Date('2031-01-15T15:00:00Z'),
      canceladoEm: new Date('2031-02-10T15:00:00Z'),
      status: 'estornado',
    });

    const d = await buildCaller().admin.receita.dashboard({
      de: '2031-02-01',
      ate: '2031-03-01',
      granularidade: 'mes',
    });
    expect(d.timezone).toBe('America/Sao_Paulo');
    expect(d.cards.periodo.resultadoDeTaxasCents).toBe(-100);
    expect(d.porCampanha.rows).toEqual([
      {
        idCampanha: campanha,
        titulo: expect.any(String),
        campaignSlug: 'cha-router',
        publicOwnerSlug: 'dona-router',
        administrators: {
          shown: [
            {
              idConta: conta,
              displayName: 'Pessoa dona-router',
              email: 'dona-router@receita.test',
              hasUserRow: true,
            },
          ],
          total: 1,
        },
        taxasRegistradasCents: 0,
        cancelamentosCents: 100,
        resultadoDeTaxasCents: -100,
      },
    ]);
    expect(d.limitesDeDados).toEqual({
      custoProvedor: 'desconhecido',
      receitaLiquida: 'desconhecida',
      estornoParcial: 'nao_refletido_no_ledger',
      disputa: 'nao_refletida_no_ledger',
      linhasSemPagamentoResolvivel: 'nao_contadas_cobertura_inconclusiva',
    });
    expect(typeof d.snapshotAt).toBe('string');
  });

  it('drilldown pelo router: cursor inválido ⇒ BAD_REQUEST', async () => {
    await expect(
      buildCaller().admin.receita.campanhasPaginated({
        de: '2031-02-01',
        ate: '2031-03-01',
        cursor: 'nao-e-cursor',
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('T18: detalhe da campanha devolve TODOS os administradores e o slug público', async () => {
    const campanha = await seedCampanha({ slug: 'sete-admins', titulo: 'Sete admins' });
    const contas = Array.from(
      { length: 7 },
      (_, i) => `12000000-0000-4000-8000-00000000e00${i + 1}`,
    );
    for (const conta of contas) await seedAdministrador(campanha, conta);
    await seedUsuario({ idConta: contas[6] as string, slug: 'setima-pessoa' });

    const caller = buildCaller({
      campanhaRepository: {
        findById: async () => ({
          id: campanha,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          titulo: 'Sete admins',
          slug: 'sete-admins',
          criadaEm: new Date('2031-01-01T00:00:00Z'),
          dadosRecebedor: null,
          opcoes: [],
          idsAdministradores: contas,
        }),
      } as unknown as ServerDeps['campanhaRepository'],
    });
    const detalhe = await caller.admin.campanhas.findById({ idCampanha: campanha });
    expect(detalhe?.slug).toBe('sete-admins');
    expect(detalhe?.publicOwnerSlug).toBe('setima-pessoa');
    expect(detalhe?.administradores.total).toBe(7);
    expect(detalhe?.administradores.rows.map((a) => a.idConta)).toEqual(contas);
    expect(detalhe?.administradores.rows.at(-1)).toEqual({
      idConta: contas[6],
      nomeExibicao: 'Pessoa setima-pessoa',
      email: 'setima-pessoa@receita.test',
      temUsuario: true,
    });
  });
});
