import type { Kysely } from 'kysely';
import { sql } from 'kysely';

const CONVIDADOS_PRESENCA_CHECK = sql`presenca IN ('nao_enviado', 'enviado', 'sim', 'nao', 'talvez')`;

const CONVIDADOS_PRESENCA_CHECK_PREVIOUS = sql`presenca IN ('sim', 'nao', 'talvez')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('convidados').dropConstraint('convidados_presenca_check').execute();

  await db.schema
    .alterTable('convidados')
    .addCheckConstraint('convidados_presenca_check', CONVIDADOS_PRESENCA_CHECK)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('convidados').dropConstraint('convidados_presenca_check').execute();

  await db.schema
    .alterTable('convidados')
    .addCheckConstraint('convidados_presenca_check', CONVIDADOS_PRESENCA_CHECK_PREVIOUS)
    .execute();
}
