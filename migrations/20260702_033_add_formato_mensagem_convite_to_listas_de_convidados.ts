import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('listas_de_convidados')
    .addColumn('formato_mensagem_convite', 'varchar(20)')
    .execute();

  await sql`
    UPDATE listas_de_convidados
    SET formato_mensagem_convite = 'texto'
    WHERE formato_mensagem_convite IS NULL
  `.execute(db);

  await db.schema
    .alterTable('listas_de_convidados')
    .alterColumn('formato_mensagem_convite', (col) => col.setNotNull())
    .execute();

  await db.schema
    .alterTable('listas_de_convidados')
    .addCheckConstraint(
      'listas_de_convidados_formato_check',
      sql`formato_mensagem_convite IN ('convite_virtual', 'texto')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('listas_de_convidados')
    .dropConstraint('listas_de_convidados_formato_check')
    .execute();

  await db.schema
    .alterTable('listas_de_convidados')
    .dropColumn('formato_mensagem_convite')
    .execute();
}
