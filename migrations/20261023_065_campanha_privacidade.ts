import { type Kysely, sql } from 'kysely';

/**
 * "Exibir recados publicamente" (aperture-851nu). Sem linha = padrão ligado.
 *
 * IF NOT EXISTS: staging pode ainda ter a tabela criada pela versão anterior
 * da 062 (PR #177, mesmo shape); prod não tem. Ambos convergem aqui.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS campanha_privacidade (
      campanha_id uuid PRIMARY KEY REFERENCES campanhas(id),
      exibir_recados boolean NOT NULL DEFAULT true,
      atualizado_em timestamptz NOT NULL DEFAULT now()
    )
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
