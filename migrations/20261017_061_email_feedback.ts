import { type Kysely, sql } from 'kysely';

/**
 * "Avalie sua experiência" answers from lifecycle emails (aperture-tykv8).
 * One row per delivery: answering again edits the same row. Tenant, user and
 * type are copied from the delivery at write time, never taken from the form.
 * A comment-only answer (from "escrever meu comentário") has no nota.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE email_feedback (
      id uuid PRIMARY KEY,
      delivery_id uuid NOT NULL UNIQUE REFERENCES lifecycle_email_deliveries(id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL,
      user_id uuid NOT NULL,
      type text NOT NULL,
      nota smallint CHECK (nota BETWEEN 1 AND 5),
      comentario text CHECK (comentario IS NULL OR char_length(comentario) BETWEEN 1 AND 1000),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (nota IS NOT NULL OR comentario IS NOT NULL)
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('email_feedback').execute();
}
