import { type Kysely, sql } from 'kysely';

/**
 * aperture-bqvb5 — agradecer quem presenteou.
 *   - `campanha_privacidade.mensagem_agradecimento`: mensagem padrão que a
 *     titular configura (NULL = usa a sugerida pelo app).
 *   - `agradecimentos_presentes`: quando cada presente (pagamento) já foi
 *     agradecido, para o painel mostrar "agradecido ♡" e avisar antes de
 *     agradecer de novo. Só acrescenta; nenhum dado financeiro muda.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE campanha_privacidade ADD COLUMN mensagem_agradecimento text`.execute(db);
  await sql`
    CREATE TABLE agradecimentos_presentes (
      id_pagamento uuid PRIMARY KEY REFERENCES pagamentos(id) ON DELETE CASCADE,
      id_campanha uuid NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
      agradecido_em timestamptz NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX agradecimentos_presentes_campanha_idx
    ON agradecimentos_presentes (id_campanha)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE agradecimentos_presentes`.execute(db);
  await sql`ALTER TABLE campanha_privacidade DROP COLUMN mensagem_agradecimento`.execute(db);
}
