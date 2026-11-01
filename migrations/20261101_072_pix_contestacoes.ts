import { type Kysely, sql } from 'kysely';

/** MED is an administrative reserve, not a refund or a ledger rewrite. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE pix_contestacoes (
    id uuid PRIMARY KEY,
    id_pagamento uuid NOT NULL UNIQUE REFERENCES pagamentos(id) ON DELETE CASCADE,
    caso_id text UNIQUE,
    valor_cents integer NOT NULL CHECK (valor_cents > 0),
    estado text NOT NULL DEFAULT 'bloqueada' CHECK (estado IN ('bloqueada', 'liberada', 'devolvida')),
    ocorrida_em timestamptz NOT NULL,
    resolvida_em timestamptz,
    notas text NOT NULL DEFAULT '',
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    criado_por text NOT NULL,
    atualizado_por text
  )`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pix_contestacoes) THEN
      RAISE EXCEPTION 'Cannot drop MED evidence: pix_contestacoes is not empty';
    END IF;
  END $$`.execute(db);
  await sql`DROP TABLE pix_contestacoes`.execute(db);
}
