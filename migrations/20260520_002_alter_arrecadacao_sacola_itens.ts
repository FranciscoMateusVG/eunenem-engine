import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('opcoes_contribuicao').dropColumn('valor').execute();

  await db.schema.alterTable('contribuicoes').addColumn('nome', 'varchar(120)').execute();

  await sql`UPDATE contribuicoes SET nome = 'Item' WHERE nome IS NULL`.execute(db);

  await db.schema
    .alterTable('contribuicoes')
    .alterColumn('nome', (col) => col.setNotNull())
    .execute();

  await db.schema
    .alterTable('contribuicoes')
    .alterColumn('contribuinte_nome', (col) => col.dropNotNull())
    .execute();

  await db.schema
    .alterTable('contribuicoes')
    .alterColumn('contribuinte_email', (col) => col.dropNotNull())
    .execute();

  await db.schema
    .alterTable('contribuicoes')
    .dropConstraint('contribuicoes_status_check')
    .execute();

  await sql`
    UPDATE contribuicoes
    SET status = 'indisponivel'
    WHERE status = 'pendente_pagamento'
  `.execute(db);

  await db.schema
    .alterTable('contribuicoes')
    .addCheckConstraint('contribuicoes_status_check', sql`status IN ('disponivel', 'indisponivel')`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('contribuicoes')
    .dropConstraint('contribuicoes_status_check')
    .execute();

  await sql`
    UPDATE contribuicoes
    SET status = 'pendente_pagamento'
    WHERE status IN ('disponivel', 'indisponivel')
  `.execute(db);

  await db.schema
    .alterTable('contribuicoes')
    .addCheckConstraint('contribuicoes_status_check', sql`status IN ('pendente_pagamento')`)
    .execute();

  await db.schema.alterTable('contribuicoes').dropColumn('nome').execute();

  await db.schema
    .alterTable('contribuicoes')
    .alterColumn('contribuinte_nome', (col) => col.setNotNull())
    .execute();

  await db.schema
    .alterTable('contribuicoes')
    .alterColumn('contribuinte_email', (col) => col.setNotNull())
    .execute();

  await db.schema
    .alterTable('opcoes_contribuicao')
    .addColumn('valor', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  await sql`ALTER TABLE opcoes_contribuicao ALTER COLUMN valor DROP DEFAULT`.execute(db);
}
