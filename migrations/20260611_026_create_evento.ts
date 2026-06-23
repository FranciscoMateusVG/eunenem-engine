import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('eventos')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_campanha', 'uuid', (col) => col.notNull())
    .addColumn('tipo_evento', 'varchar(40)', (col) => col.notNull())
    .addColumn('modalidade', 'varchar(20)', (col) => col.notNull())
    .addColumn('data_hora', 'timestamptz', (col) => col.notNull())
    .addColumn('endereco', 'varchar(500)')
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('eventos_id_campanha_uniq', ['id_campanha'])
    .addForeignKeyConstraint('eventos_id_campanha_fk', ['id_campanha'], 'campanhas', ['id'], (cb) =>
      cb.onDelete('cascade'),
    )
    .addCheckConstraint(
      'eventos_tipo_evento_check',
      sql`tipo_evento IN ('cha-bebe', 'cha-fraldas', 'cha-surpresa', 'cha-revelacao', 'batizado', 'aniversario')`,
    )
    .addCheckConstraint('eventos_modalidade_check', sql`modalidade IN ('presencial', 'online')`)
    .execute();

  await db.schema
    .createTable('convites')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_evento', 'uuid', (col) => col.notNull())
    .addColumn('remetente', 'varchar(120)', (col) => col.notNull())
    .addColumn('nome_exibido', 'varchar(120)', (col) => col.notNull())
    .addColumn('mensagem', 'varchar(2000)', (col) => col.notNull())
    .addColumn('paleta', 'varchar(40)', (col) => col.notNull())
    .addColumn('fonte', 'varchar(20)', (col) => col.notNull())
    .addColumn('modelo', 'varchar(40)', (col) => col.notNull())
    .addColumn('imagem_url', 'text')
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('convites_id_evento_uniq', ['id_evento'])
    .addForeignKeyConstraint('convites_id_evento_fk', ['id_evento'], 'eventos', ['id'], (cb) =>
      cb.onDelete('cascade'),
    )
    .addCheckConstraint(
      'convites_paleta_check',
      sql`paleta IN ('lilas', 'rosa-coral', 'verde-limao', 'azul-claro', 'amarelo', 'cream', 'surpresa')`,
    )
    .addCheckConstraint('convites_fonte_check', sql`fonte IN ('patrick', 'caveat')`)
    .addCheckConstraint(
      'convites_modelo_check',
      sql`modelo IN ('scrapbook', 'varal-de-mimos', 'balao-de-ar', 'jardim-romantico', 'lavanda', 'floresta-magica', 'roupinhas-e-coracoes', 'berco-floral', 'arco-iris-boho', 'margaridas', 'girafinha-bailarina', 'safari', 'elefantinho')`,
    )
    .execute();

  await db.schema
    .createTable('listas_de_convidados')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_evento', 'uuid', (col) => col.notNull())
    .addColumn('link_confirmacao', 'text', (col) => col.notNull())
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('listas_de_convidados_id_evento_uniq', ['id_evento'])
    .addForeignKeyConstraint(
      'listas_de_convidados_id_evento_fk',
      ['id_evento'],
      'eventos',
      ['id'],
      (cb) => cb.onDelete('cascade'),
    )
    .execute();

  await db.schema
    .createTable('convidados')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('lista_id', 'uuid', (col) => col.notNull())
    .addColumn('nome', 'varchar(120)', (col) => col.notNull())
    .addColumn('numero_celular', 'varchar(20)', (col) => col.notNull())
    .addColumn('presenca', 'varchar(20)', (col) => col.notNull())
    .addForeignKeyConstraint(
      'convidados_lista_id_fk',
      ['lista_id'],
      'listas_de_convidados',
      ['id'],
      (cb) => cb.onDelete('cascade'),
    )
    .addCheckConstraint('convidados_presenca_check', sql`presenca IN ('sim', 'nao', 'talvez')`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('convidados').execute();
  await db.schema.dropTable('listas_de_convidados').execute();
  await db.schema.dropTable('convites').execute();
  await db.schema.dropTable('eventos').execute();
}
