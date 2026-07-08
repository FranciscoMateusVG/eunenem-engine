import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryPostgres } from '../../../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import {
  criarLancamentosParaPagamentoAprovado,
  type EfeitosFinanceirosPagamentoAprovado,
  type IdsLancamentosFinanceirosPorPagamento,
  type LancamentoFinanceiro,
} from '../../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { IdItemDoPagamento } from '../../../../src/domain/pagamentos/value-objects/ids.js';

/**
 * Regression test for aperture-dqrac (P1 hotfix).
 *
 * The Plan 0016 Phase 2 migration 023 added `id_item_pagamento` to
 * `lancamentos_financeiros` as a NOT NULL FK to `intencao_items.id`. The
 * postgres adapter's row mapper (rowFromLancamento + lancamentoFromRow)
 * and its `LancamentoRow` type were not updated — every INSERT omitted
 * the column, so Postgres rejected every cartão pagamento webhook with:
 *
 *   null value in column "id_item_pagamento" of relation
 *   "lancamentos_financeiros" violates not-null constraint
 *
 * Operator surfaced this 2026-06-09 02:03 UTC on a real Stripe test-mode
 * cartão payment (idPagamento b08e28fa-f90a-49ea-8a84-9151fd6e29b2).
 *
 * This test pins the adapter at the row-mapper layer:
 *   1. Every `INSERT INTO lancamentos_financeiros` carries
 *      `id_item_pagamento` for every row (contribuicao recebedor +
 *      contribuicao receita + passthrough_surcharge).
 *   2. The round-trip via `findLancamentosByIdPagamento` rehydrates the
 *      entity with `idItemPagamento` populated.
 *
 * The fixture exercises a cartão cart (2 contribuição items + 1
 * surcharge) — the same shape the operator hit when the bug fired.
 */

const idPagamento = '550e8400-e29b-41d4-a716-446655442001';
const idContribuicaoA = '550e8400-e29b-41d4-a716-446655442002';
const idContribuicaoB = '550e8400-e29b-41d4-a716-446655442003';
const idCampanha = '550e8400-e29b-41d4-a716-446655442004';

const idItemContribuicaoA = '550e8400-e29b-41d4-a716-446655442010';
const idItemContribuicaoB = '550e8400-e29b-41d4-a716-446655442011';
const idItemSurcharge = '550e8400-e29b-41d4-a716-446655442012';

function makeAprovadoLancamentos(): readonly LancamentoFinanceiro[] {
  const input: EfeitosFinanceirosPagamentoAprovado = {
    idPagamento: idPagamento as never,
    idCampanha: idCampanha as never,
    statusPagamento: 'aprovado',
    idContribuicaoAnchor: idContribuicaoA as never,
    items: [
      {
        idItemPagamento: idItemContribuicaoA,
        composicaoValoresItem: {
          tipo: 'contribuicao',
          idContribuicao: idContribuicaoA as never,
          quantidade: 1,
          contributionUnitAmountCents: 4500 as never,
          feeUnitAmountCents: 225 as never,
          receiverUnitAmountCents: 4500 as never,
          lineContributionAmountCents: 4500 as never,
          lineFeeAmountCents: 225 as never,
          lineReceiverAmountCents: 4500 as never,
        },
      },
      {
        idItemPagamento: idItemContribuicaoB,
        composicaoValoresItem: {
          tipo: 'contribuicao',
          idContribuicao: idContribuicaoB as never,
          quantidade: 2,
          contributionUnitAmountCents: 3000 as never,
          feeUnitAmountCents: 150 as never,
          receiverUnitAmountCents: 3000 as never,
          lineContributionAmountCents: 6000 as never,
          lineFeeAmountCents: 300 as never,
          lineReceiverAmountCents: 6000 as never,
        },
      },
      {
        idItemPagamento: idItemSurcharge,
        composicaoValoresItem: {
          tipo: 'passthrough_surcharge',
          amountCents: 200 as never,
        },
      },
    ],
  };
  const ids: IdsLancamentosFinanceirosPorPagamento = [
    {
      idItemPagamento: idItemContribuicaoA,
      idLancamentoRecebedor: randomUUID(),
      idLancamentoReceitaPlataforma: randomUUID(),
    },
    {
      idItemPagamento: idItemContribuicaoB,
      idLancamentoRecebedor: randomUUID(),
      idLancamentoReceitaPlataforma: randomUUID(),
    },
    {
      idItemPagamento: idItemSurcharge,
      idLancamentoPassthroughSurcharge: randomUUID(),
    },
  ];
  return criarLancamentosParaPagamentoAprovado(
    input,
    ids,
    new Date('2026-06-09T02:03:12.000Z'),
  );
}

/**
 * Minimal Kysely-shaped stub. Captures the values() rows on
 * `insertInto('lancamentos_financeiros')`. Mirrors the surface the adapter
 * actually touches; the adapter uses `this.db as any` for these calls so
 * structural typing isn't enforced — we only need shape parity at runtime.
 */
function makeCaptureDb(): {
  readonly db: unknown;
  readonly inserts: Array<{ table: string; rows: ReadonlyArray<Record<string, unknown>> }>;
  // biome-ignore lint/suspicious/noExplicitAny: stub
  readonly selectRowsByTable: Map<string, Record<string, any>[]>;
} {
  const inserts: Array<{ table: string; rows: ReadonlyArray<Record<string, unknown>> }> = [];
  // biome-ignore lint/suspicious/noExplicitAny: stub
  const selectRowsByTable = new Map<string, Record<string, any>[]>();

  const insertBuilder = (table: string) => ({
    values: (rows: ReadonlyArray<Record<string, unknown>>) => ({
      execute: async () => {
        inserts.push({ table, rows });
        // Stash for round-trip — keyed by id_pagamento so
        // findLancamentosByIdPagamento can replay them.
        const stash = selectRowsByTable.get(table) ?? [];
        for (const r of rows) {
          stash.push({ ...r });
        }
        selectRowsByTable.set(table, stash);
      },
    }),
  });

  // biome-ignore lint/suspicious/noExplicitAny: stub
  const selectBuilder = (table: string) => {
    let predicate: ((row: Record<string, unknown>) => boolean) | null = null;
    const builder = {
      selectAll: () => builder,
      where: (col: string, _op: string, val: unknown) => {
        const prev = predicate;
        predicate = (row) => {
          if (prev && !prev(row)) return false;
          return row[col] === val;
        };
        return builder;
      },
      execute: async () => {
        const rows = selectRowsByTable.get(table) ?? [];
        return predicate ? rows.filter(predicate) : rows;
      },
    };
    return builder;
  };

  const db = {
    insertInto: (table: string) => insertBuilder(table),
    selectFrom: (table: string) => selectBuilder(table),
  };

  return { db, inserts, selectRowsByTable };
}

describe('LivroFinanceiroRepositoryPostgres — row mapper carries id_item_pagamento (aperture-dqrac)', () => {
  it('saveLancamentos: every INSERT row has id_item_pagamento populated (no NOT NULL violation)', async () => {
    const lancamentos = makeAprovadoLancamentos();
    expect(lancamentos).toHaveLength(5); // 2 contribuição × 2 + 1 surcharge

    // Pre-condition sanity: the entity already carries the field. The
    // bug lived in the row mapper, not the factory.
    for (const l of lancamentos) {
      expect(l.idItemPagamento).toBeTruthy();
    }

    const capture = makeCaptureDb();
    // biome-ignore lint/suspicious/noExplicitAny: stub injection
    const repo = new LivroFinanceiroRepositoryPostgres(capture.db as any);
    await repo.saveLancamentos(lancamentos);

    // One INSERT batch into the lancamentos_financeiros table.
    expect(capture.inserts).toHaveLength(1);
    const batch = capture.inserts[0];
    expect(batch?.table).toBe('lancamentos_financeiros');
    expect(batch?.rows).toHaveLength(5);

    for (const row of batch?.rows ?? []) {
      expect(row.id_item_pagamento).toBeTruthy();
      expect(typeof row.id_item_pagamento).toBe('string');
    }

    // Item-id parity check: the three distinct intencao_items.id values
    // appear across the 5 rows with the expected fan-out (2 per
    // contribuição item, 1 for the surcharge).
    const countByItem = new Map<string, number>();
    for (const row of batch?.rows ?? []) {
      const itemId = row.id_item_pagamento as string;
      countByItem.set(itemId, (countByItem.get(itemId) ?? 0) + 1);
    }
    expect(countByItem.get(idItemContribuicaoA)).toBe(2);
    expect(countByItem.get(idItemContribuicaoB)).toBe(2);
    expect(countByItem.get(idItemSurcharge)).toBe(1);
  });

  it('findLancamentosByIdPagamento: rehydrates idItemPagamento from the persisted row', async () => {
    const lancamentos = makeAprovadoLancamentos();
    const capture = makeCaptureDb();
    // biome-ignore lint/suspicious/noExplicitAny: stub injection
    const repo = new LivroFinanceiroRepositoryPostgres(capture.db as any);

    await repo.saveLancamentos(lancamentos);
    const found = await repo.findLancamentosByIdPagamento(idPagamento as never);

    expect(found).toHaveLength(5);
    for (const l of found) {
      expect(l.idItemPagamento).toBeTruthy();
    }

    // Round-trip check on the surcharge row specifically — the bug fired
    // identically for all rows in prod, but surcharge is the most
    // distinctive shape (single lançamento, no companion).
    const surcharge = found.find((l) => l.tipo === 'credito_passthrough_surcharge');
    expect(surcharge).toBeDefined();
    expect(surcharge?.idItemPagamento as unknown as IdItemDoPagamento).toBe(idItemSurcharge);
  });
});
