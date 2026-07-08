/**
 * Regression test (aperture-t0sxe) — a pagamento `update()` must PRESERVE
 * previously-booked lançamentos.
 *
 * THE BUG: `PagamentoRepositoryPostgres.update()` used to delete+reinsert
 * `intencao_items` on every call. Because
 * `lancamentos_financeiros.id_item_pagamento` has an ON DELETE CASCADE FK
 * to `intencao_items(id)` (migration 20260609_023), a metadata-only
 * update() (e.g. persisting `balanceTransactionAvailableOn` from
 * checkout.session.completed) CASCADE-DELETED the already-booked financial
 * ledger. Card payments whose charge.succeeded booking landed just before
 * a near-concurrent metadata update silently lost their lançamentos and
 * vanished from the extrato.
 *
 * THE FIX (aperture-t0sxe): update() no longer touches intencao_items —
 * items are write-once at save(). This test locks that invariant.
 *
 * Flow:
 *   1. save() a credit_card pagamento (creates real intencao_items rows:
 *      one contribuicao item + one passthrough_surcharge item).
 *   2. Book lançamentos directly via LivroFinanceiroRepositoryPostgres,
 *      each FK-referencing a real intencao_items.id from the saved cart
 *      (recebedor + receita on the contribuicao item, passthrough on the
 *      surcharge item — 3 rows). Assert they were persisted (precondition).
 *   3. update() the SAME pagamento with a METADATA-ONLY change
 *      (balanceTransactionAvailableOn + status flip + charge ref).
 *   4. Assert findLancamentosByIdPagamento STILL returns the same 3
 *      lançamentos (none cascade-deleted) AND the intencao_items still
 *      exist. This is the regression lock.
 *
 * With the bug present (delete+reinsert in update()), step 4's lançamento
 * assertion fails — the metadata update cascades through the deleted items
 * and wipes the ledger.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { Pagamento } from '../../src/domain/pagamentos/entities/pagamento.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type {
  IdContribuicaoReferencia,
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
} from '../../src/domain/pagamentos/financeiro/value-objects/ids.js';
import type { IdItemDoPagamento } from '../../src/domain/pagamentos/value-objects/ids.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { seedPagamentoParents } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncatePagamentosTables } from '../helpers/truncate-pagamentos.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
});

describe('PagamentoRepositoryPostgres.update() preserves booked lançamentos (aperture-t0sxe)', () => {
  let pagamentoRepo: PagamentoRepositoryPostgres;
  let livroRepo: LivroFinanceiroRepositoryPostgres;

  beforeEach(async () => {
    // Order matters: lançamentos FK intencao_items FK pagamentos. Wipe the
    // ledger first, then the pagamentos (which cascades its items).
    // biome-ignore lint/suspicious/noExplicitAny: lancamentos_financeiros is in generated types but the BC-scoped Database surface narrows it out
    await (testDb.db as any).deleteFrom('lancamentos_financeiros').execute();
    await truncatePagamentosTables(testDb.db);

    pagamentoRepo = new PagamentoRepositoryPostgres(testDb.db);
    livroRepo = new LivroFinanceiroRepositoryPostgres(testDb.db);
  });

  it('a metadata-only update() does NOT cascade-delete the booked lançamentos', async () => {
    // ── 1. save() a credit_card pagamento → real intencao_items rows ──
    const pagamento = makePagamento({ metodo: 'credit_card', status: 'aprovado' });
    // Seed the FK parents (campanha + contribuição chain) the adapter
    // honours on save (migrations 022 + 023).
    await seedPagamentoParents(testDb.db, pagamento);
    await pagamentoRepo.save(pagamento);

    // The credit_card cart carries 2 items: a contribuicao item + a
    // passthrough_surcharge item. Grab their real ids from the aggregate
    // so the lançamentos FK to rows that actually exist.
    const contribItem = pagamento.intencao.items.find((i) => i.tipo === 'contribuicao');
    const surchargeItem = pagamento.intencao.items.find((i) => i.tipo === 'passthrough_surcharge');
    expect(contribItem).toBeDefined();
    expect(surchargeItem).toBeDefined();
    if (!contribItem || !surchargeItem) throw new Error('fixture must carry both item tipos');

    const idPagamento = pagamento.id as unknown as IdPagamentoReferencia;
    const idContribuicao =
      (contribItem.idContribuicao as unknown as IdContribuicaoReferencia) ??
      (randomUUID() as IdContribuicaoReferencia);
    const idCampanha = pagamento.intencao.idCampanha as unknown as IdCampanha;

    // ── 2. Book lançamentos referencing the real item ids ──
    const recebedor: LancamentoFinanceiro = {
      id: randomUUID() as IdLancamentoFinanceiro,
      idPagamento,
      idItemPagamento: contribItem.id as unknown as IdItemDoPagamento,
      idContribuicao,
      idCampanha,
      tipo: 'credito_saldo_recebedor',
      amountCents: 8000,
      criadoEm: new Date('2026-05-01T12:05:00.000Z'),
      transferidoEm: null,
      canceladoEm: null,
      idRepasse: null,
    };
    const receita: LancamentoFinanceiro = {
      id: randomUUID() as IdLancamentoFinanceiro,
      idPagamento,
      idItemPagamento: contribItem.id as unknown as IdItemDoPagamento,
      idContribuicao,
      // receita_plataforma rows carry no campanha
      tipo: 'credito_receita_plataforma',
      amountCents: 400,
      criadoEm: new Date('2026-05-01T12:05:00.000Z'),
      transferidoEm: null,
      canceladoEm: null,
      idRepasse: null,
    };
    const passthrough: LancamentoFinanceiro = {
      id: randomUUID() as IdLancamentoFinanceiro,
      idPagamento,
      idItemPagamento: surchargeItem.id as unknown as IdItemDoPagamento,
      idContribuicao,
      idCampanha,
      tipo: 'credito_passthrough_surcharge',
      amountCents: 50,
      criadoEm: new Date('2026-05-01T12:05:00.000Z'),
      transferidoEm: null,
      canceladoEm: null,
      idRepasse: null,
    };

    await livroRepo.saveLancamentos([recebedor, receita, passthrough]);

    // Precondition: the ledger is booked (3 rows).
    const antes = await livroRepo.findLancamentosByIdPagamento(idPagamento);
    expect(antes).toHaveLength(3);
    const idsAntes = antes.map((l) => l.id).sort();
    expect(idsAntes).toEqual([recebedor.id, receita.id, passthrough.id].sort());

    // ── 3. Metadata-only update() — items unchanged ──
    const updated: Pagamento = {
      ...pagamento,
      status: 'aprovado',
      intencao: {
        ...pagamento.intencao,
        // The exact webhook write that triggered the bug in prod:
        // checkout.session.completed persisting availability + charge ref.
        balanceTransactionAvailableOn: new Date('2026-05-04T00:00:00.000Z'),
        chargeExternalRef: 'ch_test_t0sxe_regression',
      },
    };
    await pagamentoRepo.update(updated);

    // ── 4. REGRESSION LOCK: the ledger survived the update ──
    const depois = await livroRepo.findLancamentosByIdPagamento(idPagamento);
    expect(depois).toHaveLength(3); // none cascade-deleted
    expect(depois.map((l) => l.id).sort()).toEqual(idsAntes);

    // And the metadata write actually landed (proves update() ran).
    const reloaded = await pagamentoRepo.findById(pagamento.id);
    expect(reloaded?.intencao.balanceTransactionAvailableOn).toEqual(
      new Date('2026-05-04T00:00:00.000Z'),
    );
    expect(reloaded?.intencao.chargeExternalRef).toBe('ch_test_t0sxe_regression');

    // Optional: the intencao_items themselves still exist (the cascade
    // source). If update() had deleted+reinserted them, the original item
    // ids would be gone (reinsert mints the same ids here, but the booked
    // lançamentos would already have cascaded away in between).
    expect(reloaded?.intencao.items).toHaveLength(2);
    const idsItensDepois = reloaded?.intencao.items.map((i) => i.id).sort();
    expect(idsItensDepois).toEqual([contribItem.id, surchargeItem.id].sort());
  });
});
