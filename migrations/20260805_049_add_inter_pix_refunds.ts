import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Durable Banco Inter PIX refund state.
 *
 * Inter's devolucao endpoint is asynchronous. The client-generated
 * `id_devolucao` is therefore both the retry idempotency key and the stable
 * handle used to verify callback hints against Inter's authoritative API.
 * Provider references only are persisted here; payer/recipient PII is not.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pagamentos').addColumn('intencao_e2e_external_ref', 'text').execute();

  // A settlement e2e id belongs to exactly one payment. Legacy and unsettled
  // rows remain NULL and therefore do not participate in the index.
  await sql`
    CREATE UNIQUE INDEX pagamentos_intencao_e2e_ref_uniq
      ON pagamentos (intencao_e2e_external_ref)
      WHERE intencao_e2e_external_ref IS NOT NULL
  `.execute(db);

  await db.schema
    .createTable('pix_cobranca_devolucoes')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_pagamento', 'uuid', (col) => col.notNull())
    .addColumn('e2e_id', 'text', (col) => col.notNull())
    .addColumn('id_devolucao', 'varchar(35)', (col) => col.notNull())
    // Banco Inter's canonical wire ceiling is 999,999,999,999 cents, which
    // exceeds PostgreSQL INTEGER. Match the aggregate payment cents carriers.
    .addColumn('amount_cents', 'bigint', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('rtr_id', 'text')
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      'pix_cobranca_devolucoes_id_pagamento_fk',
      ['id_pagamento'],
      'pagamentos',
      ['id'],
      // Refund audit state must not disappear with its payment. Deleting a
      // payment with refund history is rejected and requires explicit repair.
      (constraint) => constraint.onDelete('restrict'),
    )
    // The current refund contract permits one durable refund lifecycle per
    // payment. Retries update that row instead of creating another transfer.
    .addUniqueConstraint('pix_cobranca_devolucoes_id_pagamento_uniq', ['id_pagamento'])
    // Inter callback/re-query correlation is scoped by the original receipt
    // and our client-generated refund id.
    .addUniqueConstraint('pix_cobranca_devolucoes_e2e_id_id_devolucao_uniq', [
      'e2e_id',
      'id_devolucao',
    ])
    .addCheckConstraint(
      'pix_cobranca_devolucoes_e2e_id_check',
      sql`char_length(e2e_id) = 32 AND e2e_id ~ '^[A-Za-z0-9]+$'`,
    )
    .addCheckConstraint(
      'pix_cobranca_devolucoes_id_devolucao_check',
      sql`char_length(id_devolucao) BETWEEN 26 AND 35 AND id_devolucao ~ '^[A-Za-z0-9]+$'`,
    )
    .addCheckConstraint('pix_cobranca_devolucoes_amount_cents_check', sql`amount_cents > 0`)
    .addCheckConstraint(
      'pix_cobranca_devolucoes_status_check',
      sql`status IN ('em_processamento', 'devolvida', 'nao_realizada', 'rejeitada')`,
    )
    .execute();

  // `rtr_id` is assigned by Inter after the refund enters its asynchronous
  // lifecycle. Callback handlers can use it when present without indexing the
  // NULL-heavy pre-response rows.
  await sql`
    CREATE INDEX pix_cobranca_devolucoes_rtr_id_idx
      ON pix_cobranca_devolucoes (rtr_id)
      WHERE rtr_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('pix_cobranca_devolucoes').execute();
  await sql`DROP INDEX IF EXISTS pagamentos_intencao_e2e_ref_uniq`.execute(db);
  await db.schema.alterTable('pagamentos').dropColumn('intencao_e2e_external_ref').execute();
}
