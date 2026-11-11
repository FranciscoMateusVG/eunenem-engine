import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { caixaParaCsv } from '../../apps/eunenem-server/pages/lib/caixaCsv.js';
import {
  InvalidCaixaPeriodoError,
  loadCaixaPainel,
} from '../../apps/eunenem-server/server/admin-caixa.js';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * Fluxo de caixa (aperture-zoxel) contra Postgres real. Datas em 2033 para
 * ficar independente de resíduo de outras suítes no container compartilhado.
 *
 *   C1  entradas = presente + taxa + adicional, em centavos exatos, == total
 *       pago dos pagamentos; por método
 *   C2  borda de fuso: 23:59 SP e 00:00 SP caem em dias diferentes
 *   C3  estorno entra pela data do cancelamento; líquido = bruto − estornos
 *   C4  saída só com transferido_em; aprovado/verificando = pendente, fora da saída
 *   C5  saldo = entradas líquidas − saídas; série == total independente
 *   C6  outra plataforma não entra
 *   C7  leitura pura: nenhuma linha de pagamento/repasse muda
 *   C8  CSV: centavos exatos + período
 *   C9  tRPC admin.caixa.painel/csv atrás do gate, período inválido ⇒ 400
 */

const OTHER_PLATFORM = '00000000-0000-4000-8000-00000000f9c1';
const NOW = new Date('2033-06-18T15:00:00.000Z');

let testDb: TestDatabase;
const seeded = {
  campaigns: new Set<string>(),
  lancamentos: new Set<string>(),
  repasses: new Set<string>(),
};

// biome-ignore lint/suspicious/noExplicitAny: fixtures cruzam vários BCs
const anyDb = () => testDb.db as any;

async function wipe(): Promise<void> {
  const db = anyDb();
  if (seeded.lancamentos.size > 0) {
    await db
      .deleteFrom('lancamentos_financeiros')
      .where('id', 'in', [...seeded.lancamentos])
      .execute();
  }
  if (seeded.repasses.size > 0) {
    await db
      .deleteFrom('repasses_recebedor')
      .where('id', 'in', [...seeded.repasses])
      .execute();
  }
  const campaigns = [...seeded.campaigns];
  if (campaigns.length > 0) {
    const pagamentos = db
      .selectFrom('pagamentos')
      .select('id')
      .where('intencao_id_campanha', 'in', campaigns);
    await db.deleteFrom('intencao_items').where('id_pagamento', 'in', pagamentos).execute();
    await db.deleteFrom('pagamentos').where('intencao_id_campanha', 'in', campaigns).execute();
    await db.deleteFrom('contribuicoes').where('campanha_id', 'in', campaigns).execute();
    await db.deleteFrom('opcoes_contribuicao').where('campanha_id', 'in', campaigns).execute();
    await db.deleteFrom('campanhas').where('id', 'in', campaigns).execute();
  }
  seeded.lancamentos.clear();
  seeded.repasses.clear();
  seeded.campaigns.clear();
}

async function seedCampanha(platformId = ID_PLATAFORMA_EUNENEM): Promise<string> {
  const id = randomUUID();
  await anyDb()
    .insertInto('campanhas')
    .values({ id, id_plataforma: platformId, titulo: `Campanha ${id.slice(0, 8)}`, slug: null })
    .execute();
  seeded.campaigns.add(id);
  return id;
}

interface PagamentoSeed {
  readonly campaignId: string;
  readonly presenteCents: number;
  readonly taxaCents: number;
  readonly adicionalCents?: number;
  readonly criadoEm: Date;
  readonly canceladoEm?: Date | null;
  readonly metodo?: 'pix' | 'credit_card';
  readonly idRepasse?: string | null;
  readonly transferidoEm?: Date | null;
}

/** Pagamento aprovado + os lançamentos que o livro grava para ele. */
async function seedPagamento(input: PagamentoSeed): Promise<{ idPagamento: string }> {
  const db = anyDb();
  const idPagamento = randomUUID();
  const idContribuicao = randomUUID();
  const adicional = input.adicionalCents ?? 0;
  const total = input.presenteCents + input.taxaCents + adicional;
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
      valor: input.presenteCents,
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
      ${idPagamento}::uuid, 'aprovado', ${input.criadoEm}, ${input.criadoEm},
      ${randomUUID()}::uuid, ${input.campaignId}::uuid,
      ${metodo}, ${input.criadoEm},
      ${input.presenteCents}, ${input.taxaCents}, ${input.presenteCents}, ${adicional},
      ${total},
      ${JSON.stringify({
        id: `ext-${idPagamento}`,
        provedor: metodo === 'pix' ? 'inter' : 'stripe',
        status: 'aprovado',
        amountCents: total,
        criadaEm: input.criadoEm.toISOString(),
        statusBruto: 'paid',
      })}::jsonb
    )
  `.execute(testDb.db);

  const linhas: Array<{ tipo: string; cents: number; position: number; item: string | null }> = [
    {
      tipo: 'credito_saldo_recebedor',
      cents: input.presenteCents,
      position: 0,
      item: 'contribuicao',
    },
    { tipo: 'credito_receita_plataforma', cents: input.taxaCents, position: 0, item: null },
  ];
  if (adicional > 0) {
    linhas.push({
      tipo: 'credito_passthrough_surcharge',
      cents: adicional,
      position: 1,
      item: 'passthrough_surcharge',
    });
  }
  // Um item de contribuição (presente+taxa) e, se houver, um de adicional.
  const idItemContribuicao = randomUUID();
  await db
    .insertInto('intencao_items')
    .values({
      id: idItemContribuicao,
      id_pagamento: idPagamento,
      id_intencao_pagamento: idPagamento,
      position: 0,
      tipo: 'contribuicao',
      id_contribuicao: idContribuicao,
      quantidade: 1,
      contribution_unit_amount_cents: input.presenteCents,
      fee_unit_amount_cents: input.taxaCents,
      receiver_unit_amount_cents: input.presenteCents,
      line_contribution_amount_cents: input.presenteCents,
      line_fee_amount_cents: input.taxaCents,
      line_receiver_amount_cents: input.presenteCents,
      surcharge_amount_cents: null,
      criado_em: input.criadoEm,
    })
    .execute();
  let idItemAdicional: string | null = null;
  if (adicional > 0) {
    idItemAdicional = randomUUID();
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
        surcharge_amount_cents: adicional,
        criado_em: input.criadoEm,
      })
      .execute();
  }
  for (const linha of linhas) {
    const id = randomUUID();
    const ehSaldo = linha.tipo === 'credito_saldo_recebedor';
    await db
      .insertInto('lancamentos_financeiros')
      .values({
        id,
        id_pagamento: idPagamento,
        id_item_pagamento:
          linha.item === 'passthrough_surcharge' ? idItemAdicional : idItemContribuicao,
        id_contribuicao: idContribuicao,
        id_campanha: linha.tipo === 'credito_receita_plataforma' ? null : input.campaignId,
        tipo: linha.tipo,
        amount_cents: linha.cents,
        criado_em: input.criadoEm,
        cancelado_em: input.canceladoEm ?? null,
        id_repasse: ehSaldo ? (input.idRepasse ?? null) : null,
        transferido_em: ehSaldo ? (input.transferidoEm ?? null) : null,
      })
      .execute();
    seeded.lancamentos.add(id);
  }
  return { idPagamento };
}

async function seedRepasse(input: {
  campaignId: string;
  amountCents: number;
  status: string;
  solicitadoEm: Date;
  interCodigo?: string | null;
  bankRef?: string | null;
  enviadoAoBancoEm?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await anyDb()
    .insertInto('repasses_recebedor')
    .values({
      id,
      id_campanha: input.campaignId,
      amount_cents: input.amountCents,
      status: input.status,
      solicitado_em: input.solicitadoEm,
      aprovado_em: input.status === 'solicitado' ? null : input.solicitadoEm,
      inter_codigo_solicitacao: input.interCodigo ?? null,
      bank_transfer_ref: input.bankRef ?? null,
      enviado_ao_banco_em: input.enviadoAoBancoEm ?? null,
    })
    .execute();
  seeded.repasses.add(id);
  return id;
}

const periodo = (de: string, ate: string, granularidade: 'dia' | 'semana' | 'mes' = 'dia') => ({
  de,
  ate,
  granularidade,
});

function load(p: ReturnType<typeof periodo>) {
  return loadCaixaPainel(testDb.db, { platformId: ID_PLATAFORMA_EUNENEM, periodo: p, now: NOW });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await testDb?.teardown();
});
beforeEach(async () => {
  await wipe();
});

describe('Fluxo de caixa — contra Postgres real', () => {
  it('C1/C5: entradas em centavos exatos por componente e método; saldo = líquidas − saídas', async () => {
    const campanha = await seedCampanha();
    // PIX 10.000 + taxa 700 (total 10.700) em 10/ago, cartão 5.000 + 350 + 183 em 11/ago.
    await seedPagamento({
      campaignId: campanha,
      presenteCents: 10_000,
      taxaCents: 700,
      criadoEm: new Date('2033-08-10T15:00:00Z'),
    });
    const { idPagamento: idCartao } = await seedPagamento({
      campaignId: campanha,
      presenteCents: 5_000,
      taxaCents: 350,
      adicionalCents: 183,
      metodo: 'credit_card',
      criadoEm: new Date('2033-08-11T15:00:00Z'),
    });
    const repasse = await seedRepasse({
      campaignId: campanha,
      amountCents: 6_000,
      status: 'pago',
      solicitadoEm: new Date('2033-08-12T12:00:00Z'),
      interCodigo: 'cod-1',
    });
    // Presente do pagamento de cartão (5.000) + 1.000 do PIX repassados? Mantém simples:
    // marca o lançamento de saldo do cartão como transferido (5.000) e outro pedaço via 2º repasse.
    await anyDb()
      .updateTable('lancamentos_financeiros')
      .set({ id_repasse: repasse, transferido_em: new Date('2033-08-12T18:00:00Z') })
      .where('id_pagamento', '=', idCartao)
      .where('tipo', '=', 'credito_saldo_recebedor')
      .execute();
    await anyDb()
      .updateTable('repasses_recebedor')
      .set({ amount_cents: 5_000 })
      .where('id', '=', repasse)
      .execute();

    const painel = await load(periodo('2033-08-01', '2033-09-01', 'mes'));

    expect(painel.entradas.presenteCents).toBe(15_000);
    expect(painel.entradas.taxaCents).toBe(1_050);
    expect(painel.entradas.adicionalCartaoCents).toBe(183);
    expect(painel.entradas.brutoCents).toBe(16_233);
    expect(painel.entradas.estornosCents).toBe(0);
    expect(painel.entradas.liquidoCents).toBe(16_233);
    expect(painel.entradas.pagamentos).toBe(2);
    expect(painel.entradas.porMetodo.pix).toMatchObject({
      presenteCents: 10_000,
      taxaCents: 700,
      adicionalCartaoCents: 0,
      brutoCents: 10_700,
    });
    expect(painel.entradas.porMetodo.credit_card).toMatchObject({
      presenteCents: 5_000,
      taxaCents: 350,
      adicionalCartaoCents: 183,
      brutoCents: 5_533,
    });
    expect(painel.saidas.totalCents).toBe(5_000);
    expect(painel.saidas.repasses).toBe(1);
    expect(painel.saidas.porMetodo.inter.cents).toBe(5_000);
    expect(painel.saldoCents).toBe(16_233 - 5_000);

    // Reconciliação com o livro: bruto == soma do total pago; saída == repasse.
    expect(painel.conciliacao.totalPagoDosPagamentosCents).toBe(16_233);
    expect(painel.conciliacao.diferencas).toEqual({
      entradasBrutasCents: 0,
      estornosCents: 0,
      saidasCents: 0,
      totalPagoCents: 0,
      repassesCents: 0,
    });
    const somaSerie = painel.serie.reduce((a, b) => a + b.entradasBrutasCents, 0);
    expect(somaSerie).toBe(painel.entradas.brutoCents);
  });

  it('C2: 23:59 e 00:00 em São Paulo caem em dias diferentes; meio-dia UTC não vaza', async () => {
    const campanha = await seedCampanha();
    // 2033-08-10 23:59:59 SP = 2033-08-11T02:59:59Z ; 2033-08-11 00:00:00 SP = 03:00:00Z.
    await seedPagamento({
      campaignId: campanha,
      presenteCents: 1_000,
      taxaCents: 70,
      criadoEm: new Date('2033-08-11T02:59:59Z'),
    });
    await seedPagamento({
      campaignId: campanha,
      presenteCents: 2_000,
      taxaCents: 140,
      criadoEm: new Date('2033-08-11T03:00:00Z'),
    });

    const dia10 = await load(periodo('2033-08-10', '2033-08-11'));
    expect(dia10.entradas.brutoCents).toBe(1_070);
    const dia11 = await load(periodo('2033-08-11', '2033-08-12'));
    expect(dia11.entradas.brutoCents).toBe(2_140);
    const ambos = await load(periodo('2033-08-10', '2033-08-12'));
    expect(ambos.serie.map((s) => [s.inicio, s.entradasBrutasCents])).toEqual([
      ['2033-08-10', 1_070],
      ['2033-08-11', 2_140],
    ]);
    expect(ambos.entradas.brutoCents).toBe(3_210);
  });

  it('C3: estorno entra pela data do cancelamento; líquido = bruto − estornos', async () => {
    const campanha = await seedCampanha();
    await seedPagamento({
      campaignId: campanha,
      presenteCents: 10_000,
      taxaCents: 700,
      criadoEm: new Date('2033-08-30T15:00:00Z'),
      canceladoEm: new Date('2033-09-02T15:00:00Z'),
    });
    const ago = await load(periodo('2033-08-01', '2033-09-01', 'mes'));
    expect(ago.entradas.brutoCents).toBe(10_700);
    expect(ago.entradas.estornosCents).toBe(0);
    const set = await load(periodo('2033-09-01', '2033-10-01', 'mes'));
    expect(set.entradas.brutoCents).toBe(0);
    expect(set.entradas.estornosCents).toBe(10_700);
    expect(set.entradas.liquidoCents).toBe(-10_700);
    expect(set.saldoCents).toBe(-10_700);
    const ambos = await load(periodo('2033-08-01', '2033-10-01', 'mes'));
    expect(ambos.entradas.liquidoCents).toBe(0);
  });

  it('C4: só transferido_em é saída; aprovado/transferindo/enviado/falhou e verificando ficam pendentes', async () => {
    const campanha = await seedCampanha();
    const dia = new Date('2033-08-10T15:00:00Z');
    const mk = async (status: string, extra: Record<string, unknown> = {}, presente = 1_000) => {
      const repasse = await seedRepasse({
        campaignId: campanha,
        amountCents: presente,
        status,
        solicitadoEm: dia,
        ...extra,
      });
      return repasse;
    };
    const pago = await mk('pago', { interCodigo: 'c1' }, 1_000);
    const pagoManual = await mk('aprovado', { bankRef: 'TED-1' }, 2_000);
    const aprovado = await mk('aprovado', {}, 3_000);
    const transferindo = await mk('transferindo', {}, 4_000);
    const enviado = await mk(
      'enviado_ao_banco',
      { interCodigo: 'c5', enviadoAoBancoEm: dia },
      5_000,
    );
    const falhou = await mk('falhou', {}, 6_000);
    const verificando = await mk('verificando', {}, 7_000);
    const solicitado = await mk('solicitado', {}, 8_000);
    const cancelado = await mk('cancelado', {}, 9_000);
    // #284: conta aprovada, carimbada transferido_em SEM envio e SEM referência.
    const semComprovante = await mk('aprovado', {}, 1_500);

    const plan: Array<[string, number, Date | null]> = [
      [pago, 1_000, new Date('2033-08-12T15:00:00Z')],
      [pagoManual, 2_000, new Date('2033-08-12T16:00:00Z')],
      [aprovado, 3_000, null],
      [transferindo, 4_000, null],
      [enviado, 5_000, null],
      [falhou, 6_000, null],
      [verificando, 7_000, null],
      [solicitado, 8_000, null],
      [semComprovante, 1_500, new Date('2033-08-12T17:00:00Z')],
    ];
    for (const [idRepasse, presente, transferidoEm] of plan) {
      await seedPagamento({
        campaignId: campanha,
        presenteCents: presente,
        taxaCents: 0,
        criadoEm: dia,
        idRepasse,
        transferidoEm,
      });
    }
    void cancelado;

    const painel = await load(periodo('2033-08-01', '2033-09-01', 'mes'));
    expect(painel.saidas.totalCents).toBe(3_000);
    expect(painel.saidas.repasses).toBe(2);
    expect(painel.saidas.porMetodo.inter).toEqual({ cents: 1_000, repasses: 1 });
    expect(painel.saidas.porMetodo.manual).toEqual({ cents: 2_000, repasses: 1 });
    // aprovados ainda não transferidos: aprovado + transferindo + enviado_ao_banco + falhou.
    expect(painel.pendentes.aprovadosNaoTransferidos).toEqual({
      cents: 3_000 + 4_000 + 5_000 + 6_000,
      repasses: 4,
    });
    expect(painel.pendentes.emVerificacao).toEqual({ cents: 7_000, repasses: 1 });
    // Marcado como transferido sem comprovante: pendente, NUNCA saída.
    expect(painel.pendentes.semComprovante).toEqual({ cents: 1_500, repasses: 1 });
    // Pendente nunca entra no saldo.
    expect(painel.saldoCents).toBe(painel.entradas.liquidoCents - 3_000);
    expect(painel.conciliacao.diferencas.repassesCents).toBe(0);
    // Pendente é foto de agora: não muda com o período escolhido.
    const outro = await load(periodo('2033-01-01', '2033-02-01', 'mes'));
    expect(outro.pendentes).toEqual(painel.pendentes);
    expect(outro.saidas.totalCents).toBe(0);
  });

  it('C5: série (dia/semana/mês) soma igual ao total independente', async () => {
    const campanha = await seedCampanha();
    const dias = [
      '2033-08-01T12:00:00Z',
      '2033-08-07T12:00:00Z',
      '2033-08-08T12:00:00Z',
      '2033-08-20T12:00:00Z',
      '2033-08-31T12:00:00Z',
    ];
    let esperado = 0;
    for (const [i, d] of dias.entries()) {
      const presente = 1_000 + i * 137;
      await seedPagamento({
        campaignId: campanha,
        presenteCents: presente,
        taxaCents: 7 * (i + 1),
        criadoEm: new Date(d),
      });
      esperado += presente + 7 * (i + 1);
    }
    for (const g of ['dia', 'semana', 'mes'] as const) {
      const painel = await load(periodo('2033-08-01', '2033-09-01', g));
      expect(painel.entradas.brutoCents).toBe(esperado);
      expect(painel.serie.reduce((a, b) => a + b.entradasBrutasCents, 0)).toBe(esperado);
      expect(painel.conciliacao.diferencas.entradasBrutasCents).toBe(0);
    }
    const semanas = await load(periodo('2033-08-01', '2033-09-01', 'semana'));
    // 01/ago/2033 é segunda-feira; semana de 08/ago separada da de 01/ago.
    expect(semanas.serie[0]?.inicio).toBe('2033-08-01');
    expect(semanas.serie[1]?.inicio).toBe('2033-08-08');
  });

  it('C6: outra plataforma não entra em nenhum número', async () => {
    const minha = await seedCampanha();
    const alheia = await seedCampanha(OTHER_PLATFORM);
    await seedPagamento({
      campaignId: minha,
      presenteCents: 1_000,
      taxaCents: 70,
      criadoEm: new Date('2033-08-10T15:00:00Z'),
    });
    const r = await seedRepasse({
      campaignId: alheia,
      amountCents: 9_000,
      status: 'verificando',
      solicitadoEm: NOW,
    });
    await seedPagamento({
      campaignId: alheia,
      presenteCents: 9_000,
      taxaCents: 630,
      criadoEm: new Date('2033-08-10T15:00:00Z'),
      idRepasse: r,
      transferidoEm: new Date('2033-08-11T15:00:00Z'),
    });
    const painel = await load(periodo('2033-08-01', '2033-09-01', 'mes'));
    expect(painel.entradas.brutoCents).toBe(1_070);
    expect(painel.saidas.totalCents).toBe(0);
    expect(painel.pendentes.emVerificacao).toEqual({ cents: 0, repasses: 0 });
    expect(painel.pendentes.semComprovante).toEqual({ cents: 0, repasses: 0 });
  });

  it('C7: leitura pura — nenhuma linha de pagamento/repasse/lançamento muda', async () => {
    const campanha = await seedCampanha();
    const repasse = await seedRepasse({
      campaignId: campanha,
      amountCents: 1_000,
      status: 'pago',
      solicitadoEm: NOW,
      interCodigo: 'x',
    });
    await seedPagamento({
      campaignId: campanha,
      presenteCents: 1_000,
      taxaCents: 70,
      criadoEm: new Date('2033-08-10T15:00:00Z'),
      idRepasse: repasse,
      transferidoEm: new Date('2033-08-11T15:00:00Z'),
    });
    const hash = async () =>
      (
        await sql<{ h: string }>`
          SELECT md5(
            (SELECT COALESCE(string_agg(p::text, ',' ORDER BY p.id), '') FROM pagamentos p WHERE p.intencao_id_campanha = ${campanha}::uuid) ||
            (SELECT COALESCE(string_agg(r::text, ',' ORDER BY r.id), '') FROM repasses_recebedor r WHERE r.id_campanha = ${campanha}::uuid) ||
            (SELECT COALESCE(string_agg(l::text, ',' ORDER BY l.id), '') FROM lancamentos_financeiros l WHERE l.id_campanha = ${campanha}::uuid)
          ) AS h`.execute(testDb.db)
      ).rows[0]?.h;
    const antes = await hash();
    await load(periodo('2033-08-01', '2033-09-01', 'mes'));
    expect(await hash()).toBe(antes);
    // E a transação é somente leitura: uma escrita no mesmo snapshot falharia.
    await expect(
      testDb.db.transaction().execute(async (trx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        await loadCaixaPainel(trx, {
          platformId: ID_PLATAFORMA_EUNENEM,
          periodo: periodo('2033-08-01', '2033-09-01', 'mes'),
          now: NOW,
        });
        await sql`UPDATE repasses_recebedor SET amount_cents = 1 WHERE id = ${repasse}::uuid`.execute(
          trx,
        );
      }),
    ).rejects.toThrow();
  });

  it('C8: CSV com centavos exatos, período e linhas de pendente fora do saldo', async () => {
    const campanha = await seedCampanha();
    await seedPagamento({
      campaignId: campanha,
      presenteCents: 10_000,
      taxaCents: 700,
      adicionalCents: 5,
      metodo: 'credit_card',
      criadoEm: new Date('2033-08-10T15:00:00Z'),
    });
    const painel = await load(periodo('2033-08-01', '2033-09-01', 'mes'));
    const csv = caixaParaCsv(painel);
    const linhas = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(linhas[0]).toBe('secao,item,centavos,reais');
    expect(linhas).toContain('periodo,de,,2033-08-01');
    expect(linhas).toContain('periodo,ate_exclusivo,,2033-09-01');
    expect(linhas).toContain('entradas,presente,10000,"100,00"');
    expect(linhas).toContain('entradas,taxa_eunenem,700,"7,00"');
    expect(linhas).toContain('entradas,adicional_cartao,5,"0,05"');
    expect(linhas).toContain('entradas,bruto,10705,"107,05"');
    expect(linhas).toContain('saldo,saldo_do_periodo,10705,"107,05"');
    expect(linhas.some((l) => l.startsWith('serie,2033-08-01|2033-09-01|'))).toBe(true);
    // CSV = tela: contagens e conferência também vão no arquivo.
    expect(linhas).toContain('contagens,pagamentos_aprovados,1,');
    expect(linhas).toContain('contagens,repasses_transferidos,0,');
    expect(linhas).toContain('contagens,repasses_inter_automatico,0,');
    expect(linhas).toContain('contagens,repasses_manual,0,');
    expect(linhas).toContain('contagens,pendentes_aprovados_nao_transferidos_repasses,0,');
    expect(linhas).toContain('contagens,pendentes_em_verificacao_repasses,0,');
    expect(linhas).toContain('contagens,pendentes_sem_comprovante_repasses,0,');
    expect(linhas).toContain('conciliacao,total_pago_dos_pagamentos,10705,"107,05"');
    expect(linhas).toContain('conciliacao,total_dos_repasses,0,"0,00"');
    expect(linhas).toContain('conciliacao,diferenca_entradas_brutas,0,"0,00"');
    expect(linhas).toContain('conciliacao,diferenca_estornos,0,"0,00"');
    expect(linhas).toContain('conciliacao,diferenca_saidas,0,"0,00"');
    expect(linhas).toContain('conciliacao,diferenca_total_pago,0,"0,00"');
    expect(linhas).toContain('conciliacao,diferenca_repasses,0,"0,00"');
    expect(linhas).toContain(
      'pendentes_nao_contam_como_saida,marcados_transferidos_sem_comprovante,0,"0,00"',
    );
  });

  it('C9: tRPC admin.caixa.painel/csv atrás do gate; período inválido ⇒ BAD_REQUEST', async () => {
    const auth = adminAuthOverrides();
    const deps = {
      db: testDb.db,
      clock: () => NOW,
      ...auth.depsOverrides,
    } as unknown as ServerDeps;
    const ctx = (headers: Headers): TrpcContext =>
      ({ deps, headers, resHeaders: new Headers() }) as unknown as TrpcContext;
    const anon = appRouter.createCaller(ctx(new Headers()));
    await expect(
      anon.admin.caixa.painel(periodo('2033-08-01', '2033-09-01', 'mes')),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const campanha = await seedCampanha();
    await seedPagamento({
      campaignId: campanha,
      presenteCents: 1_000,
      taxaCents: 70,
      criadoEm: new Date('2033-08-10T15:00:00Z'),
    });
    const admin = appRouter.createCaller(ctx(auth.headers));
    const p = await admin.admin.caixa.painel(periodo('2033-08-01', '2033-09-01', 'mes'));
    expect(p.entradas.brutoCents).toBe(1_070);
    const csv = await admin.admin.caixa.csv(periodo('2033-08-01', '2033-09-01', 'mes'));
    expect(csv.nomeArquivo).toBe('fluxo-de-caixa_2033-08-01_a_2033-08-31.csv');
    expect(csv.conteudo).toContain('entradas,bruto,1070,"10,70"');
    // Sem credencial de admin na allowlist: FORBIDDEN (logado, mas não admin).
    const naoAdmin = appRouter.createCaller({
      deps: { ...deps, adminAllowedEmails: new Set() },
      headers: auth.headers,
      resHeaders: new Headers(),
    } as unknown as TrpcContext);
    await expect(
      naoAdmin.admin.caixa.painel(periodo('2033-08-01', '2033-09-01', 'mes')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      naoAdmin.admin.caixa.csv(periodo('2033-08-01', '2033-09-01', 'mes')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      admin.admin.caixa.painel(periodo('2033-09-01', '2033-08-01', 'mes')),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      admin.admin.caixa.painel({ de: '2033-08-01', ate: '2033-09-01', granularidade: 'dia' }),
    ).resolves.toBeDefined();
    void InvalidCaixaPeriodoError;
  });
});
