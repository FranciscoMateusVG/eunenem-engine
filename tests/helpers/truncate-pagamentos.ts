import type { Database } from '../../src/adapters/database.js';

/**
 * Trunca a tabela `pagamentos` para testes de conformance.
 *
 * Most cross-BC references remain unconstrained UUIDs, but migration 049's
 * refund state intentionally owns a real FK to pagamentos. Delete that child
 * first, then clear the aggregate table.
 */
export async function truncatePagamentosTables(db: Database): Promise<void> {
  // Migration 049 adds a real FK from PIX refund attempts to pagamentos.
  // Delete children first; the FK intentionally uses the default RESTRICT
  // semantics so payment history cannot disappear under a refund record.
  await db.deleteFrom('pix_cobranca_devolucoes').execute();
  await db.deleteFrom('pagamentos').execute();
}
