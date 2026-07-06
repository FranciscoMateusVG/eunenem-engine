import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('listas_de_convidados').dropColumn('link_confirmacao').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // down() restores the schema SHAPE, not the data — the dropped values
  // aren't recoverable, so this comes back nullable (no NOT NULL/backfill).
  await db.schema
    .alterTable('listas_de_convidados')
    .addColumn('link_confirmacao', 'text')
    .execute();
}
