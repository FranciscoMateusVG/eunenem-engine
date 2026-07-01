import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Waitlist temporária do chá rifa na landing (fase 1 — captura apenas).
 *
 * Armazena e-mails de visitantes que querem ser avisados quando o chá rifa
 * entrar no ar. `notificado_em` é reservada para marcar envio (em uma fase futura);
 *
 * Dado operacional da landing — não é BC da engine Frame. Sem FK para
 * `plataformas` (catálogo hoje é in-memory; UUID espelhado como em
 * campanhas / pagina-router).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('cha_rifa_waitlist')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_plataforma', 'uuid', (col) => col.notNull())
    .addColumn('email', 'varchar(320)', (col) => col.notNull())
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('notificado_em', 'timestamptz')
    .execute();

  await db.schema
    .alterTable('cha_rifa_waitlist')
    .addUniqueConstraint('cha_rifa_waitlist_plataforma_email_uniq', ['id_plataforma', 'email'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('cha_rifa_waitlist').execute();
}
