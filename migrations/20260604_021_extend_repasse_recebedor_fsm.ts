import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Track 1 of aperture-q2d4b (bead aperture-s03dr). Extends the
 * RepasseRecebedor FSM from 1-state (`solicitado`) to 2-state
 * (`solicitado → aprovado`), wires the id_repasse linkage on
 * lancamentos_financeiros, and adds the concurrency guard (unique
 * partial index — at most one pending repasse per campanha).
 *
 * ───── lancamentos_financeiros: id_repasse linkage ─────
 *
 *   ADD COLUMN id_repasse uuid NULL.
 *
 * NOT a strong FK to repasses_recebedor at the DB level — we keep
 * BC-internal references soft (matches the existing id_pagamento /
 * id_contribuicao / id_campanha shape on this same table). Soft
 * partial index covers the "find lancamentos linked to this repasse"
 * query (used by the admin aprovar path):
 *
 *   CREATE INDEX lancamentos_financeiros_id_repasse_idx
 *     ON lancamentos_financeiros (id_repasse)
 *     WHERE id_repasse IS NOT NULL;
 *
 * Partial because the vast majority of rows have id_repasse NULL at
 * any given time (only the subset already swept into a pending
 * repasse carries a value).
 *
 * ───── repasses_recebedor: FSM extension ─────
 *
 *   ADD COLUMN aprovado_em timestamptz NULL    (admin approval moment)
 *   ADD COLUMN bank_transfer_ref text NULL     (optional PIX/TED ref)
 *   DROP + RECREATE status CHECK to allow {'solicitado','aprovado'}
 *
 * ───── concurrency guard ─────
 *
 *   CREATE UNIQUE INDEX repasses_um_solicitado_por_campanha
 *     ON repasses_recebedor (id_campanha)
 *     WHERE status = 'solicitado';
 *
 * At most ONE pending repasse per campanha at any given time.
 * Two concurrent solicitação attempts on the same campanha — one
 * wins; the loser surfaces a 23505 which the postgres adapter
 * translates to FinanceiroRepasseJaPendenteError. The solicitação
 * use-case also issues `SELECT FOR UPDATE` on the candidate
 * lancamentos inside the transaction to serialize on the row-level
 * lock as well; the unique partial index is the authoritative guard,
 * the row lock is the cheaper happy-path serialization.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ───── lancamentos_financeiros.id_repasse ─────
  await db.schema.alterTable('lancamentos_financeiros').addColumn('id_repasse', 'uuid').execute();

  await sql`
    CREATE INDEX lancamentos_financeiros_id_repasse_idx
      ON lancamentos_financeiros (id_repasse)
      WHERE id_repasse IS NOT NULL
  `.execute(db);

  // ───── repasses_recebedor: aprovado_em + bank_transfer_ref ─────
  await db.schema
    .alterTable('repasses_recebedor')
    .addColumn('aprovado_em', 'timestamptz')
    .execute();

  await db.schema.alterTable('repasses_recebedor').addColumn('bank_transfer_ref', 'text').execute();

  // ───── status CHECK extension ─────
  await sql`
    ALTER TABLE repasses_recebedor
      DROP CONSTRAINT repasses_recebedor_status_check
  `.execute(db);

  await sql`
    ALTER TABLE repasses_recebedor
      ADD CONSTRAINT repasses_recebedor_status_check
      CHECK (status IN ('solicitado', 'aprovado'))
  `.execute(db);

  // ───── concurrency guard: at most one pending per campanha ─────
  await sql`
    CREATE UNIQUE INDEX repasses_um_solicitado_por_campanha
      ON repasses_recebedor (id_campanha)
      WHERE status = 'solicitado'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS repasses_um_solicitado_por_campanha
  `.execute(db);

  await sql`
    ALTER TABLE repasses_recebedor
      DROP CONSTRAINT repasses_recebedor_status_check
  `.execute(db);

  await sql`
    ALTER TABLE repasses_recebedor
      ADD CONSTRAINT repasses_recebedor_status_check
      CHECK (status IN ('solicitado'))
  `.execute(db);

  await db.schema.alterTable('repasses_recebedor').dropColumn('bank_transfer_ref').execute();

  await db.schema.alterTable('repasses_recebedor').dropColumn('aprovado_em').execute();

  await sql`
    DROP INDEX IF EXISTS lancamentos_financeiros_id_repasse_idx
  `.execute(db);

  await db.schema.alterTable('lancamentos_financeiros').dropColumn('id_repasse').execute();
}
