import type { Kysely } from 'kysely';

/**
 * Soft account deactivation. We preserve the Usuario aggregate, campaigns,
 * payments and payout history while making authentication fail closed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('usuarios').addColumn('desativado_em', 'timestamptz').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('usuarios').dropColumn('desativado_em').execute();
}
