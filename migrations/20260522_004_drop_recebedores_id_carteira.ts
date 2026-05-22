import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('recebedores_id_carteira_idx').execute();
  await db.schema.alterTable('recebedores').dropColumn('id_carteira').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('recebedores').addColumn('id_carteira', 'uuid').execute();

  await sql`UPDATE recebedores SET id_carteira = gen_random_uuid() WHERE id_carteira IS NULL`.execute(
    db,
  );

  await sql`ALTER TABLE recebedores ALTER COLUMN id_carteira SET NOT NULL`.execute(db);

  await db.schema
    .createIndex('recebedores_id_carteira_idx')
    .on('recebedores')
    .column('id_carteira')
    .execute();
}
