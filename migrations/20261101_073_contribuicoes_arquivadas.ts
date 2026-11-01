import { type Kysely, sql } from 'kysely';

/** Removed gifts remain FK parents for existing payment attempts and history. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE contribuicoes ADD COLUMN arquivada_em timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE contribuicoes DROP COLUMN arquivada_em`.execute(db);
}
