import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../src/adapters/database.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';

/**
 * Fixtures do ledger de receita da plataforma (credito_receita_plataforma)
 * com a cadeia de pais completa: campanha → opção → contribuição →
 * pagamento → intencao_item → lançamento. Mesmo shape do seedTaxa de
 * tests/integration/admin-receita.postgres.test.ts, que o
 * loadReceitaDashboard já lê em Postgres real.
 *
 * Cada seeder registra o que criou; `wipe()` apaga só isso, porque o
 * container é compartilhado entre arquivos.
 */

export interface TaxaSeed {
  readonly campaignId: string;
  readonly taxaCents: number;
  readonly criadoEm: Date;
  readonly canceladoEm?: Date | null;
  readonly status?: 'aprovado' | 'estornado' | 'pendente' | 'rejeitado';
  readonly metodo?: 'pix' | 'credit_card';
  readonly provedor?: 'stripe' | 'inter';
  /** Adicional de cartão (item + lançamento próprios; nunca é receita). */
  readonly adicionalCents?: number;
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

  async taxa(input: TaxaSeed): Promise<{ idPagamento: string; idLancamento: string }> {
    const db = this.anyDb;
    const idPagamento = randomUUID();
    const idContribuicao = randomUUID();
    const idItem = randomUUID();
    const idLancamento = randomUUID();
    const provedor = input.provedor ?? 'stripe';
    const adicional = input.adicionalCents ?? 0;
    const contribuicaoCents = input.taxaCents * 10;
    const pagoCents = contribuicaoCents + input.taxaCents + adicional;

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
    const transacaoExterna = JSON.stringify({
      id: `ext-${idPagamento}`,
      provedor,
      status: 'aprovado',
      amountCents: pagoCents,
      criadaEm: input.criadoEm.toISOString(),
      statusBruto: 'paid',
    });
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
        ${input.metodo ?? 'pix'}, ${input.criadoEm},
        ${contribuicaoCents}, ${input.taxaCents}, ${contribuicaoCents},
        ${adicional}, ${pagoCents}, ${transacaoExterna}::jsonb
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
    return { idPagamento, idLancamento };
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
