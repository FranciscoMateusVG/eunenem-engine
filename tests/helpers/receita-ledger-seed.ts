import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../src/adapters/database.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';

/**
 * Fixtures da tela Receita (aperture-q4pfz): pagamentos com a cadeia de pais
 * completa (campanha → opção → contribuição → pagamento → intencao_item →
 * lançamentos do ledger: taxa, saldo do recebedor e, se houver, adicional de
 * cartão — cuja soma é intencao_total_paid_cents) e, quando pedido, o estorno
 * total no ledger (`cancelado_em` em todas as linhas + status `estornado`) e a
 * devolução PIX do Inter (`pix_cobranca_devolucoes`). Mesmo shape do seedTaxa de
 * tests/integration/admin-receita.postgres.test.ts, que o
 * loadReceitaDashboard já lê em Postgres real.
 *
 * Cada seeder registra o que criou; `wipe()` apaga só isso, porque o
 * container é compartilhado entre arquivos.
 */

export type StatusPagamento = 'aprovado' | 'estornado' | 'pendente' | 'rejeitado';

export interface PagamentoSeed {
  readonly campaignId: string;
  /** Taxa da plataforma (linha credito_receita_plataforma). */
  readonly taxaCents: number;
  /** Valor do presente. Padrão: 10× a taxa. */
  readonly contribuicaoCents?: number;
  /** Data do pagamento aprovado e da linha de taxa. */
  readonly criadoEm: Date;
  /** Data em que a linha de taxa foi cancelada (estorno total). */
  readonly canceladoEm?: Date | null;
  readonly status?: StatusPagamento;
  readonly metodo?: 'pix' | 'credit_card';
  /** `null` ⇒ pagamento sem transacao_externa (provedor não registrado). */
  readonly provedor?: 'stripe' | 'inter' | null;
  /** Adicional de cartão (item + lançamento próprios; nunca é receita). */
  readonly adicionalCents?: number;
  /** Sem linha de taxa no ledger (ex.: pagamento pendente/rejeitado). */
  readonly semLancamento?: boolean;
}

export interface PagamentoSeedado {
  readonly idPagamento: string;
  readonly idLancamento: string | null;
  /** intencao_total_paid_cents = presente + taxa + adicional. */
  readonly pagoCents: number;
}

export interface DevolucaoInterSeed {
  readonly idPagamento: string;
  readonly amountCents: number;
  readonly status?: 'em_processamento' | 'devolvida' | 'nao_realizada' | 'rejeitada';
  readonly criadoEm: Date;
  /** Instante em que o Inter confirmou (status final). Padrão: criadoEm. */
  readonly atualizadoEm?: Date;
}

function alnum(len: number): string {
  let out = '';
  while (out.length < len) out += randomUUID().replace(/-/g, '');
  return out.slice(0, len);
}

export class ReceitaLedgerSeed {
  private readonly campaigns = new Set<string>();
  private readonly lancamentos = new Set<string>();

  constructor(private readonly db: Database) {}

  // biome-ignore lint/suspicious/noExplicitAny: fixtures cruzam vários BCs
  private get anyDb(): any {
    return this.db;
  }

  async campanha(platformId: string = ID_PLATAFORMA_EUNENEM): Promise<string> {
    const id = randomUUID();
    await this.anyDb
      .insertInto('campanhas')
      .values({ id, id_plataforma: platformId, titulo: `Campanha ${id.slice(0, 8)}` })
      .execute();
    this.campaigns.add(id);
    return id;
  }

  async pagamento(input: PagamentoSeed): Promise<PagamentoSeedado> {
    const db = this.anyDb;
    const idPagamento = randomUUID();
    const idContribuicao = randomUUID();
    const idItem = randomUUID();
    const provedor = input.provedor === undefined ? 'stripe' : input.provedor;
    const adicional = input.adicionalCents ?? 0;
    const contribuicaoCents = input.contribuicaoCents ?? input.taxaCents * 10;
    const pagoCents = contribuicaoCents + input.taxaCents + adicional;
    const metodo = input.metodo ?? (provedor === 'inter' ? 'pix' : 'credit_card');
    const status = input.status ?? (input.canceladoEm ? 'estornado' : 'aprovado');

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
    const transacaoExterna =
      provedor === null
        ? null
        : JSON.stringify({
            id: `ext-${idPagamento}`,
            provedor,
            status: 'aprovado',
            amountCents: pagoCents,
            criadaEm: input.criadoEm.toISOString(),
            statusBruto: 'paid',
          });
    // Inter: o e2e do recebimento é o vínculo exigido pela devolução.
    const e2e = provedor === 'inter' ? `E${alnum(31)}` : null;
    await sql`
      INSERT INTO pagamentos (
        id, status, criado_em, atualizado_em, intencao_id, intencao_id_campanha,
        intencao_metodo, intencao_criada_em,
        intencao_total_contribution_cents, intencao_total_fee_cents,
        intencao_total_receiver_cents, intencao_total_surcharge_cents,
        intencao_total_paid_cents, transacao_externa, intencao_e2e_external_ref
      ) VALUES (
        ${idPagamento}::uuid, ${status}, ${input.criadoEm},
        ${input.canceladoEm ?? input.criadoEm},
        ${randomUUID()}::uuid, ${input.campaignId}::uuid,
        ${metodo}, ${input.criadoEm},
        ${contribuicaoCents}, ${input.taxaCents}, ${contribuicaoCents},
        ${adicional}, ${pagoCents}, ${transacaoExterna}::jsonb, ${e2e}
      )
    `.execute(this.db);
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

    if (input.semLancamento) return { idPagamento, idLancamento: null, pagoCents };

    const idLancamento = randomUUID();
    await db
      .insertInto('lancamentos_financeiros')
      .values({
        id: idLancamento,
        id_pagamento: idPagamento,
        id_item_pagamento: idItem,
        id_contribuicao: idContribuicao,
        // Convenção do ledger: a linha de receita não carrega id_campanha.
        id_campanha: null,
        tipo: 'credito_receita_plataforma',
        amount_cents: input.taxaCents,
        criado_em: input.criadoEm,
        transferido_em: null,
        cancelado_em: input.canceladoEm ?? null,
        id_repasse: null,
      })
      .execute();
    this.lancamentos.add(idLancamento);

    // Saldo do recebedor: a terceira linha que um pagamento aprovado gera.
    // taxa + saldo + adicional = intencao_total_paid_cents.
    const idSaldo = randomUUID();
    await db
      .insertInto('lancamentos_financeiros')
      .values({
        id: idSaldo,
        id_pagamento: idPagamento,
        id_item_pagamento: idItem,
        id_contribuicao: idContribuicao,
        id_campanha: input.campaignId,
        tipo: 'credito_saldo_recebedor',
        amount_cents: contribuicaoCents,
        criado_em: input.criadoEm,
        transferido_em: null,
        cancelado_em: input.canceladoEm ?? null,
        id_repasse: null,
      })
      .execute();
    this.lancamentos.add(idSaldo);

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
      this.lancamentos.add(idAdicional);
    }
    return { idPagamento, idLancamento, pagoCents };
  }

  /** Devolução PIX do Inter (uma por pagamento, como no contrato atual). */
  async devolucaoInter(input: DevolucaoInterSeed): Promise<string> {
    const row = await sql<{ e2e: string | null }>`
      SELECT intencao_e2e_external_ref AS e2e FROM pagamentos WHERE id = ${input.idPagamento}::uuid
    `.execute(this.db);
    const e2e = row.rows[0]?.e2e;
    if (!e2e) throw new Error('fixture_devolucao_inter_sem_e2e');
    const id = randomUUID();
    await sql`
      INSERT INTO pix_cobranca_devolucoes (
        id, id_pagamento, e2e_id, id_devolucao, amount_cents, status, criado_em, atualizado_em
      ) VALUES (
        ${id}::uuid, ${input.idPagamento}::uuid, ${e2e}, ${`D${alnum(31)}`},
        ${input.amountCents}, ${input.status ?? 'devolvida'}, ${input.criadoEm},
        ${input.atualizadoEm ?? input.criadoEm}
      )
    `.execute(this.db);
    return id;
  }

  async wipe(): Promise<void> {
    const db = this.anyDb;
    const lancamentos = [...this.lancamentos];
    const campaigns = [...this.campaigns];
    if (lancamentos.length > 0) {
      await db.deleteFrom('lancamentos_financeiros').where('id', 'in', lancamentos).execute();
    }
    if (campaigns.length > 0) {
      const pagamentos = db
        .selectFrom('pagamentos')
        .select('id')
        .where('intencao_id_campanha', 'in', campaigns);
      await db
        .deleteFrom('lancamentos_financeiros')
        .where('id_pagamento', 'in', pagamentos)
        .execute();
      await db
        .deleteFrom('pix_cobranca_devolucoes')
        .where('id_pagamento', 'in', pagamentos)
        .execute();
      await db.deleteFrom('intencao_items').where('id_pagamento', 'in', pagamentos).execute();
      await db.deleteFrom('pagamentos').where('intencao_id_campanha', 'in', campaigns).execute();
      await db.deleteFrom('contribuicoes').where('campanha_id', 'in', campaigns).execute();
      await db.deleteFrom('opcoes_contribuicao').where('campanha_id', 'in', campaigns).execute();
      await db.deleteFrom('campanhas').where('id', 'in', campaigns).execute();
    }
    this.lancamentos.clear();
    this.campaigns.clear();
  }
}
