import { type Kysely, sql } from 'kysely';

/**
 * "Exibir recados publicamente" (aperture-851nu). Sem linha = padrão ligado.
 *
 * IF NOT EXISTS: staging pode ainda ter a tabela criada pela versão anterior
 * da 062 (PR #177, mesmo shape mas FK sem cascade); prod não tem. A FK é
 * recriada para os dois convergirem: a preferência some junto com a campanha,
 * sem bloquear a exclusão dela (ex.: rollback do cadastro).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS campanha_privacidade (
      campanha_id uuid PRIMARY KEY,
      exibir_recados boolean NOT NULL DEFAULT true,
      atualizado_em timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    ALTER TABLE campanha_privacidade
      DROP CONSTRAINT IF EXISTS campanha_privacidade_campanha_id_fkey,
      ADD CONSTRAINT campanha_privacidade_campanha_id_fkey
        FOREIGN KEY (campanha_id) REFERENCES campanhas(id) ON DELETE CASCADE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM campanha_privacidade
  `.execute(db);
  if (Number(rows[0]?.n ?? 0) > 0) {
    throw new Error('campanha_privacidade possui escolhas de usuários: rollback exige análise.');
  }
  await sql`DROP TABLE campanha_privacidade`.execute(db);
}
