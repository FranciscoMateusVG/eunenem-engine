import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('recebedores')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_carteira', 'uuid', (col) => col.notNull())
    .addColumn('campanha_id', 'uuid', (col) =>
      col.notNull().references('campanhas.id').onDelete('cascade'),
    )
    .addColumn('nome_titular', 'varchar(120)', (col) => col.notNull())
    .addColumn('tipo_chave_pix', 'varchar(20)', (col) => col.notNull())
    .addColumn('chave_pix', 'varchar(140)', (col) => col.notNull())
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('criada_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'recebedores_tipo_chave_pix_check',
      sql`tipo_chave_pix IN ('cpf', 'cnpj', 'email', 'telefone', 'aleatoria')`,
    )
    .execute();

  await sql`
    CREATE UNIQUE INDEX recebedores_campanha_ativo_unique
    ON recebedores (campanha_id)
    WHERE is_active = true
  `.execute(db);

  await db.schema
    .createIndex('recebedores_id_carteira_idx')
    .on('recebedores')
    .column('id_carteira')
    .execute();

  await sql`
    INSERT INTO recebedores (
      id,
      id_carteira,
      campanha_id,
      nome_titular,
      tipo_chave_pix,
      chave_pix,
      is_active,
      criada_em
    )
    SELECT
      gen_random_uuid(),
      id_recebedor,
      id,
      recebedor_nome_titular,
      recebedor_tipo_chave_pix,
      recebedor_chave_pix,
      true,
      criada_em
    FROM campanhas
  `.execute(db);

  await db.schema
    .alterTable('campanhas')
    .dropColumn('id_recebedor')
    .dropColumn('recebedor_nome_titular')
    .dropColumn('recebedor_tipo_chave_pix')
    .dropColumn('recebedor_chave_pix')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('campanhas')
    .addColumn('id_recebedor', 'uuid')
    .addColumn('recebedor_nome_titular', 'varchar(120)')
    .addColumn('recebedor_tipo_chave_pix', 'varchar(20)')
    .addColumn('recebedor_chave_pix', 'varchar(140)')
    .execute();

  await sql`
    UPDATE campanhas c
    SET
      id_recebedor = r.id_carteira,
      recebedor_nome_titular = r.nome_titular,
      recebedor_tipo_chave_pix = r.tipo_chave_pix,
      recebedor_chave_pix = r.chave_pix
    FROM recebedores r
    WHERE r.campanha_id = c.id AND r.is_active = true
  `.execute(db);

  await sql`
    ALTER TABLE campanhas
    ALTER COLUMN id_recebedor SET NOT NULL,
    ALTER COLUMN recebedor_nome_titular SET NOT NULL,
    ALTER COLUMN recebedor_tipo_chave_pix SET NOT NULL,
    ALTER COLUMN recebedor_chave_pix SET NOT NULL
  `.execute(db);

  await sql`DROP INDEX IF EXISTS recebedores_campanha_ativo_unique`.execute(db);
  await db.schema.dropIndex('recebedores_id_carteira_idx').execute();
  await db.schema.dropTable('recebedores').execute();

  await db.schema
    .alterTable('campanhas')
    .alterColumn('id_recebedor', (col) => col.setNotNull())
    .execute();

  await sql`
    CREATE UNIQUE INDEX campanhas_id_recebedor_unique ON campanhas (id_recebedor)
  `.execute(db);
}
