import type { Kysely } from 'kysely';

/**
 * Make `eventos.data_hora` nullable — date/time are now optional when
 * creating/editing a convite (the creator may not have them decided yet).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('eventos')
    .alterColumn('data_hora', (col) => col.dropNotNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Down assumes no NULL rows exist (safe only if this migration is reverted
  // immediately after being applied, before any evento is saved without a
  // dataHora) — matches the project's other reversible-in-theory migrations.
  await db.schema
    .alterTable('eventos')
    .alterColumn('data_hora', (col) => col.setNotNull())
    .execute();
}
