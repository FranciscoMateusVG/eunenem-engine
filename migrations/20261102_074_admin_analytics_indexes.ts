import { type Kysely, sql } from 'kysely';

/** Additive read-model indexes: cohort membership and payment/approval lookups. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX campanha_administradores_usuario_campanha_idx
    ON campanha_administradores (id_usuario, campanha_id)`.execute(db);
  await sql`CREATE INDEX pagamentos_campanha_criada_analytics_idx
    ON pagamentos (intencao_id_campanha, intencao_criada_em)`.execute(db);
  await sql`CREATE INDEX lancamentos_pagamento_aprovacao_analytics_idx
    ON lancamentos_financeiros (id_pagamento, criado_em)
    WHERE tipo = 'credito_receita_plataforma'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX lancamentos_pagamento_aprovacao_analytics_idx`.execute(db);
  await sql`DROP INDEX pagamentos_campanha_criada_analytics_idx`.execute(db);
  await sql`DROP INDEX campanha_administradores_usuario_campanha_idx`.execute(db);
}
