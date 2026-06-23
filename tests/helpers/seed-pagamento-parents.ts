import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/adapters/database.js';
import type { PagamentoRepository } from '../../src/adapters/pagamentos/repository.js';
import type { Pagamento } from '../../src/domain/pagamentos/entities/pagamento.js';

/**
 * Plan 0016 Phase 0/2 (migrations 022 + 023) added two FKs that the
 * Postgres `PagamentoRepository` adapter now honours when persisting a
 * Pagamento aggregate:
 *
 *   - `pagamentos.intencao_id_campanha` → `campanhas(id)`
 *     (the cart-scope invariant carrier added in migration 022).
 *   - `intencao_items.id_contribuicao` → `contribuicoes(id)`
 *     (each contribuicao-tipo cart item references a real contribuição).
 *
 * The shared conformance rig (`makePagamento`) mints fresh random UUIDs
 * for `idCampanha` + each item's `idContribuicao`. Against the in-memory
 * adapter those ids are inert. Against Postgres they must reference rows
 * that exist, or the INSERT trips the FK.
 *
 * This helper seeds the minimal parent chain for whatever ids a given
 * Pagamento carries — a campanha for its `intencao.idCampanha`, plus a
 * (campanha → opção → contribuição) chain for every contribuicao item.
 * All inserts are idempotent (`ON CONFLICT DO NOTHING`) so it is safe to
 * call before every save/update, including duplicate-save tests.
 *
 * Schema columns are pinned to the post-collapse generated types
 * (src/adapters/db-types.generated.ts):
 *   - campanhas: id, id_plataforma, titulo (criada_em defaulted)
 *   - opcoes_contribuicao: id, campanha_id, tipo
 *   - contribuicoes: id, campanha_id, id_opcao_contribuicao, nome, valor
 *     (quantidade + criada_em defaulted; grupo/imagem_url nullable)
 */
export async function seedPagamentoParents(db: Database, pagamento: Pagamento): Promise<void> {
  // Raw seed inserts against tables outside the Pagamento BC's generated
  // query surface — cast to `any` to bypass the BC-scoped Kysely typing.
  const anyDb = db as any;

  const idCampanhaPagamento = pagamento.intencao.idCampanha as string;
  await seedCampanha(anyDb, idCampanhaPagamento);

  for (const item of pagamento.intencao.items) {
    if (item.tipo !== 'contribuicao') continue;
    const idContribuicao = item.idContribuicao as string;
    // Each seeded contribuição gets its own dedicated campanha + opção
    // chain. We reuse the pagamento's campanha as the contribuição's
    // campanha so the seeded graph stays small + consistent.
    const idOpcao = await seedOpcao(anyDb, idCampanhaPagamento, idContribuicao);
    await seedContribuicao(anyDb, idContribuicao, idCampanhaPagamento, idOpcao);
  }
}

async function seedCampanha(anyDb: any, idCampanha: string): Promise<void> {
  await anyDb
    .insertInto('campanhas')
    .values({ id: idCampanha, id_plataforma: randomUUID(), titulo: 'seed' })
    .onConflict((oc: any) => oc.column('id').doNothing())
    .execute();
}

/**
 * Opção id is derived deterministically from the contribuição id so
 * repeated saves of the same contribuição reuse the same opção row.
 */
async function seedOpcao(anyDb: any, idCampanha: string, idContribuicao: string): Promise<string> {
  const idOpcao = idContribuicao; // 1:1 with the contribuição — both unique uuids
  await anyDb
    .insertInto('opcoes_contribuicao')
    .values({ id: idOpcao, campanha_id: idCampanha, tipo: 'presente' })
    .onConflict((oc: any) => oc.column('id').doNothing())
    .execute();
  return idOpcao;
}

async function seedContribuicao(
  anyDb: any,
  idContribuicao: string,
  idCampanha: string,
  idOpcao: string,
): Promise<void> {
  await anyDb
    .insertInto('contribuicoes')
    .values({
      id: idContribuicao,
      campanha_id: idCampanha,
      id_opcao_contribuicao: idOpcao,
      nome: 'seed',
      valor: 0,
    })
    .onConflict((oc: any) => oc.column('id').doNothing())
    .execute();
}

/**
 * Wrap a `PagamentoRepository` so every `save`/`update` first seeds the
 * FK parents for the pagamento being persisted. All other methods pass
 * straight through. Used only by the Postgres conformance consumer — the
 * memory adapter has no FK to satisfy.
 */
export function withParentSeeding(repo: PagamentoRepository, db: Database): PagamentoRepository {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'save' || prop === 'update') {
        return async (pagamento: Pagamento) => {
          await seedPagamentoParents(db, pagamento);
          // biome-ignore lint/suspicious/noExplicitAny: dynamic method dispatch
          return (target as any)[prop](pagamento);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as PagamentoRepository;
}
