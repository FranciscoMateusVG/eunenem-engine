import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE campanha_convites (
      id uuid PRIMARY KEY,
      campanha_id uuid NOT NULL REFERENCES campanhas(id) ON DELETE CASCADE,
      email text NOT NULL CHECK (email = lower(btrim(email))),
      criado_por uuid NOT NULL,
      criado_em timestamptz NOT NULL DEFAULT now(),
      expira_em timestamptz NOT NULL,
      revogado_em timestamptz,
      consumido_em timestamptz,
      consumido_por uuid,
      CHECK ((consumido_em IS NULL) = (consumido_por IS NULL))
    );
    CREATE UNIQUE INDEX campanha_convites_ativo ON campanha_convites(campanha_id, email)
      WHERE revogado_em IS NULL AND consumido_em IS NULL;
    CREATE INDEX campanha_convites_email ON campanha_convites(email)
      WHERE revogado_em IS NULL AND consumido_em IS NULL;
    CREATE TABLE campanha_compartilhamento_audit (
      id uuid PRIMARY KEY,
      campanha_id uuid NOT NULL,
      ator_id uuid NOT NULL,
      acao text NOT NULL,
      alvo text NOT NULL,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('campanha_compartilhamento_audit').execute();
  await db.schema.dropTable('campanha_convites').execute();
}
