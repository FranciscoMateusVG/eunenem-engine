import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('campanhas')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_recebedor', 'uuid', (col) => col.notNull().unique())
    .addColumn('titulo', 'varchar(200)', (col) => col.notNull())
    .addColumn('criada_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('recebedor_nome_titular', 'varchar(120)', (col) => col.notNull())
    .addColumn('recebedor_tipo_chave_pix', 'varchar(20)', (col) => col.notNull())
    .addColumn('recebedor_chave_pix', 'varchar(140)', (col) => col.notNull())
    .execute();

  await db.schema
    .createTable('campanha_administradores')
    .addColumn('campanha_id', 'uuid', (col) =>
      col.notNull().references('campanhas.id').onDelete('cascade'),
    )
    .addColumn('id_usuario', 'uuid', (col) => col.notNull())
    .addPrimaryKeyConstraint('campanha_administradores_pkey', ['campanha_id', 'id_usuario'])
    .execute();

  await db.schema
    .createTable('opcoes_contribuicao')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('campanha_id', 'uuid', (col) =>
      col.notNull().references('campanhas.id').onDelete('cascade'),
    )
    .addColumn('valor', 'integer', (col) => col.notNull())
    .addColumn('tipo', 'varchar(20)', (col) => col.notNull())
    .addCheckConstraint(
      'opcoes_contribuicao_tipo_check',
      sql`tipo IN ('presente', 'rifa', 'convite')`,
    )
    .execute();

  await db.schema
    .createTable('contribuicoes')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('campanha_id', 'uuid', (col) =>
      col.notNull().references('campanhas.id').onDelete('restrict'),
    )
    .addColumn('id_opcao_contribuicao', 'uuid', (col) =>
      col.notNull().references('opcoes_contribuicao.id').onDelete('restrict'),
    )
    .addColumn('valor', 'integer', (col) => col.notNull())
    .addColumn('status', 'varchar(40)', (col) => col.notNull())
    .addColumn('criada_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('contribuinte_nome_exibicao', 'varchar(120)', (col) => col.notNull())
    .addColumn('contribuinte_email', 'varchar(320)', (col) => col.notNull())
    .addCheckConstraint('contribuicoes_status_check', sql`status IN ('pendente_pagamento')`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('contribuicoes').execute();
  await db.schema.dropTable('opcoes_contribuicao').execute();
  await db.schema.dropTable('campanha_administradores').execute();
  await db.schema.dropTable('campanhas').execute();
}
