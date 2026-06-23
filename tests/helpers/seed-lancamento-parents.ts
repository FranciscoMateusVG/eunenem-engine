import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/adapters/database.js';
import type { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';

/**
 * Plan 0016 Phase 2 (migration 023) added a NOT-NULL FK
 * `lancamentos_financeiros.id_item_pagamento → intencao_items(id)`
 * (ON DELETE CASCADE). A lançamento can no longer be persisted in
 * isolation — its `intencao_items` parent must exist, which in turn
 * requires the `pagamentos` row (FK `intencao_items.id_pagamento →
 * pagamentos(id)`) and, for contribuicao-tipo items, a `contribuicoes`
 * row (FK `intencao_items.id_contribuicao → contribuicoes(id)`).
 *
 * This helper seeds that whole parent chain for the `idItemPagamento`
 * carried by each lançamento in a batch:
 *
 *   campanha → opção → contribuição → pagamento → intencao_item
 *
 * Every insert is idempotent (`ON CONFLICT DO NOTHING`) so the helper is
 * safe to call before each `saveLancamentos`, including the duplicate-
 * insert idempotency test (which re-saves lançamentos for the same
 * pagamento with fresh lançamento PKs but the SAME idItemPagamento).
 *
 * Schema columns pinned to src/adapters/db-types.generated.ts post-
 * collapse (Plan 0015 + Plan 0016).
 */
export async function seedLancamentoParents(
  db: Database,
  lancamentos: readonly LancamentoFinanceiro[],
): Promise<void> {
  // Raw seed inserts against tables outside the Financeiro BC's generated
  // query surface — cast to `any` to bypass the BC-scoped Kysely typing.
  const anyDb = db as any;

  for (const l of lancamentos) {
    const idCampanha = (l.idCampanha as string | undefined) ?? randomUUID();
    const idContribuicao = l.idContribuicao as string;
    const idPagamento = l.idPagamento as string;
    const idItemPagamento = l.idItemPagamento as string;

    await seedCampanha(anyDb, idCampanha);
    await seedOpcao(anyDb, idContribuicao, idCampanha);
    await seedContribuicao(anyDb, idContribuicao, idCampanha);
    await seedPagamento(anyDb, idPagamento, idCampanha);
    await seedIntencaoItem(anyDb, idItemPagamento, idPagamento, idContribuicao);
  }
}

async function seedCampanha(anyDb: any, idCampanha: string): Promise<void> {
  await anyDb
    .insertInto('campanhas')
    .values({ id: idCampanha, id_plataforma: randomUUID(), titulo: 'seed' })
    .onConflict((oc: any) => oc.column('id').doNothing())
    .execute();
}

/** Opção id == contribuição id (both unique uuids; distinct tables). */
async function seedOpcao(anyDb: any, idContribuicao: string, idCampanha: string): Promise<void> {
  await anyDb
    .insertInto('opcoes_contribuicao')
    .values({ id: idContribuicao, campanha_id: idCampanha, tipo: 'presente' })
    .onConflict((oc: any) => oc.column('id').doNothing())
    .execute();
}

async function seedContribuicao(
  anyDb: any,
  idContribuicao: string,
  idCampanha: string,
): Promise<void> {
  await anyDb
    .insertInto('contribuicoes')
    .values({
      id: idContribuicao,
      campanha_id: idCampanha,
      id_opcao_contribuicao: idContribuicao,
      nome: 'seed',
      valor: 0,
    })
    .onConflict((oc: any) => oc.column('id').doNothing())
    .execute();
}

async function seedPagamento(anyDb: any, idPagamento: string, idCampanha: string): Promise<void> {
  const now = new Date('2026-05-01T00:00:00Z');
  await anyDb
    .insertInto('pagamentos')
    .values({
      id: idPagamento,
      status: 'aprovado',
      criado_em: now,
      atualizado_em: now,
      intencao_id: randomUUID(),
      intencao_id_campanha: idCampanha,
      intencao_total_paid_cents: 0,
      intencao_total_contribution_cents: 0,
      intencao_total_fee_cents: 0,
      intencao_total_receiver_cents: 0,
      intencao_total_surcharge_cents: 0,
      intencao_metodo: 'pix',
      intencao_criada_em: now,
    })
    .onConflict((oc: any) => oc.column('id').doNothing())
    .execute();
}

async function seedIntencaoItem(
  anyDb: any,
  idItemPagamento: string,
  idPagamento: string,
  idContribuicao: string,
): Promise<void> {
  // Position is derived from the item id hash space only in the sense
  // that it must be unique per (id_pagamento, position). Multiple items
  // can share a pagamento in these fixtures, so derive a stable position
  // from a per-pagamento counter held in a module-local map.
  const position = nextPosition(idPagamento);
  await anyDb
    .insertInto('intencao_items')
    .values({
      id: idItemPagamento,
      id_pagamento: idPagamento,
      id_intencao_pagamento: idPagamento,
      position,
      tipo: 'contribuicao',
      id_contribuicao: idContribuicao,
      quantidade: 1,
      contribution_unit_amount_cents: 0,
      fee_unit_amount_cents: 0,
      receiver_unit_amount_cents: 0,
      line_contribution_amount_cents: 0,
      line_fee_amount_cents: 0,
      line_receiver_amount_cents: 0,
      surcharge_amount_cents: null,
      criado_em: new Date('2026-05-01T00:00:00Z'),
    })
    .onConflict((oc: any) => oc.column('id').doNothing())
    .execute();
}

/**
 * Per-pagamento position counter. The UNIQUE (id_pagamento, position)
 * constraint forbids two items sharing a position within the same
 * pagamento; tests that put multiple lançamentos (recebedor + receita +
 * passthrough) on ONE pagamento each carry a DISTINCT idItemPagamento, so
 * each gets its own seeded item row and needs a distinct position.
 */
const positionByPagamento = new Map<string, number>();
function nextPosition(idPagamento: string): number {
  const current = positionByPagamento.get(idPagamento) ?? 0;
  positionByPagamento.set(idPagamento, current + 1);
  return current;
}

/**
 * Wrap a `LivroFinanceiroRepositoryPostgres` so every `saveLancamentos`
 * first seeds the FK parents (campanha → opção → contribuição →
 * pagamento → intencao_item) for the batch being persisted. All other
 * methods pass straight through.
 *
 * Returned as the concrete class type (not the port) so the test can keep
 * calling postgres-only methods directly.
 */
export function withLancamentoSeeding(
  repo: LivroFinanceiroRepositoryPostgres,
  db: Database,
): LivroFinanceiroRepositoryPostgres {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'saveLancamentos') {
        return async (lancamentos: readonly LancamentoFinanceiro[]) => {
          await seedLancamentoParents(db, lancamentos);
          return target.saveLancamentos(lancamentos);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
