import { type Kysely, sql } from 'kysely';

/**
 * aperture-bqvb5 — the owner can archive a list. Archived lists leave the
 * public surface but keep every payment, ledger and repasse row untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE campanhas ADD COLUMN arquivada_em timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE campanhas DROP COLUMN arquivada_em`.execute(db);
}
