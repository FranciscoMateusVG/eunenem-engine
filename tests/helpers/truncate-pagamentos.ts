import type { Database } from '../../src/adapters/database.js';

/**
 * Trunca a tabela `pagamentos` para testes de conformance.
 *
 * Não há FKs apontando para `pagamentos` no schema atual — por design, as
 * referências cross-BC (lancamentos_financeiros.id_pagamento +
 * payment_webhook_events.pagamento_id) são UUIDs sem enforcement
 * relacional, para manter os BCs frouxamente acoplados (ver migrations
 * 20260531_012_create_financeiro.ts §18-19 + 20260602_016_create
 * _payment_webhook_events.ts §20-24). Um único DELETE basta.
 */
export async function truncatePagamentosTables(db: Database): Promise<void> {
  await db.deleteFrom('pagamentos').execute();
}
