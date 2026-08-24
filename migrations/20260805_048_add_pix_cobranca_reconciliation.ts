import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Persists the PIX charge expiry used by reconciliation and the short-lived
 * operational lease used to distribute work safely across workers.
 *
 * The lease is deliberately not part of the Pagamento aggregate. It is queue
 * coordination state owned by the repository and may be renewed/released
 * without changing the payment's domain state.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('pagamentos')
    .addColumn('intencao_expira_em', 'timestamptz')
    .addColumn('pix_reconciliacao_claimed_until', 'timestamptz')
    .execute();

  // Static eligibility is pinned in the partial predicate. Due-time and lease
  // checks are intentionally runtime predicates because they depend on the
  // worker's supplied clock.
  await sql`
    CREATE INDEX pagamentos_pix_reconciliacao_due_idx
      ON pagamentos (intencao_expira_em ASC, id ASC)
      WHERE intencao_metodo = 'pix'
        AND status IN ('pendente', 'processing')
        AND intencao_expira_em IS NOT NULL
        AND intencao_external_ref = replace(id::text, '-', '')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('pagamentos_pix_reconciliacao_due_idx').ifExists().execute();

  await db.schema
    .alterTable('pagamentos')
    .dropColumn('pix_reconciliacao_claimed_until')
    .dropColumn('intencao_expira_em')
    .execute();
}
