import type { Database } from '../../src/adapters/database.js';
import { truncatePagamentosTables } from './truncate-pagamentos.js';

/** Trunca tabelas do BC Arrecadação respeitando FKs. */
export async function truncateArrecadacaoTables(db: Database): Promise<void> {
  // Plan 0016 (migration 022): pagamentos now carry intencao_items, and
  // pagamentos.intencao_id_campanha FK → campanhas while
  // intencao_items.id_contribuicao FK → contribuicoes (neither cascades on
  // delete). They must be cleared BEFORE contribuicoes/campanhas, else the
  // deletes below raise FK violations across test boundaries.
  // intencao_items.id_pagamento cascades, so clearing pagamentos clears
  // items too — but we delete items first to be explicit/order-safe. The
  // shared helper also clears payment-owned child tables before pagamentos.
  await db.deleteFrom('intencao_items').execute();
  await truncatePagamentosTables(db);
  await db.deleteFrom('contribuicoes').execute();
  await db.deleteFrom('opcoes_contribuicao').execute();
  await db.deleteFrom('campanha_administradores').execute();
  await db.deleteFrom('recebedores').execute();
  await db.deleteFrom('campanhas').execute();
}
