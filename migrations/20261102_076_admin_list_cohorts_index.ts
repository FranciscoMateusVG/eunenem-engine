import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX campanhas_plataforma_criada_analytics_idx
    ON campanhas (id_plataforma, criada_em, id)`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX campanhas_plataforma_criada_analytics_idx`.execute(db);
}
