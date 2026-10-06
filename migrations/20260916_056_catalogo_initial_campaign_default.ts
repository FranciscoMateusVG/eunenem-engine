import { type Kysely, sql } from 'kysely';

/**
 * Persist the one global ready-list selected for NEW users' initial campaign.
 * Existing rows deliberately start false: an operator must select a validated
 * template through the admin mutation after this migration is deployed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('catalogo_listas')
    .addColumn('aplicar_campanha_inicial', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();

  await sql`
    CREATE UNIQUE INDEX catalogo_listas_initial_campaign_default_uniq
      ON catalogo_listas ((aplicar_campanha_inicial))
      WHERE aplicar_campanha_inicial = TRUE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('catalogo_listas_initial_campaign_default_uniq').execute();
  await db.schema.alterTable('catalogo_listas').dropColumn('aplicar_campanha_inicial').execute();
}
