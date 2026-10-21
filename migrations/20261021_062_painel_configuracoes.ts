import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE campanha_privacidade (
      campanha_id uuid PRIMARY KEY REFERENCES campanhas(id),
      exibir_recados boolean NOT NULL DEFAULT true,
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE recado_moderacao (
      pagamento_id uuid PRIMARY KEY REFERENCES pagamentos(id),
      campanha_id uuid NOT NULL REFERENCES campanhas(id),
      aprovado boolean NOT NULL DEFAULT false,
      ator_id uuid NOT NULL REFERENCES usuarios(id),
      atualizado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX recado_moderacao_campanha ON recado_moderacao(campanha_id) WHERE aprovado;
    CREATE TABLE IF NOT EXISTS solicitacoes_exclusao_conta (
      id uuid PRIMARY KEY,
      usuario_id uuid NOT NULL REFERENCES usuarios(id),
      estado text NOT NULL DEFAULT 'em_analise' CHECK(estado IN ('em_analise','concluida','cancelada')),
      verificacoes jsonb NOT NULL,
      criada_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS solicitacao_exclusao_pendente ON solicitacoes_exclusao_conta(usuario_id) WHERE estado='em_analise';
  `.execute(db);
  for (const table of [
    'lifecycle_email_preferences',
    'lifecycle_email_events',
    'lifecycle_email_deliveries',
  ]) {
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT ${sql.ref(`${table}_type_check`)}`.execute(
      db,
    );
    await sql`ALTER TABLE ${sql.table(table)} ADD CONSTRAINT ${sql.ref(`${table}_type_check`)} CHECK(type IN ('welcome','list_ready','event_reminder','payment_received','new_message','presence_confirmed'))`.execute(
      db,
    );
  }
}
export async function down(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{
    n: string;
  }>`SELECT ((SELECT count(*) FROM solicitacoes_exclusao_conta)+(SELECT count(*) FROM campanha_privacidade)+(SELECT count(*) FROM recado_moderacao))::text AS n`.execute(
    db,
  );
  if (Number(rows[0]?.n ?? 0) > 0)
    throw new Error('Configurações possuem dados: rollback exige análise e preservação manual.');
  // Wider email checks retain notification audit compatibility; no events are deleted.
  await sql`DROP TABLE recado_moderacao, campanha_privacidade, solicitacoes_exclusao_conta`.execute(
    db,
  );
}
