import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Plan 0016 Phase 0 — Multi-item pagamento + quantidade na contribuição
 * (aperture-z3cpz).
 *
 * Three coupled schema surgeries that ship together:
 *
 *   1. CONTRIBUIÇÕES — gain quantidade
 *      ─────────────────────────────────
 *      ADD `quantidade INTEGER NOT NULL DEFAULT 1` with
 *      `CHECK (quantidade >= 1)`. Lifts cardinality onto the slot so
 *      "5 wine glasses" becomes 1 row with quantidade=5 instead of 5
 *      identical rows. Default ensures existing rows backfill cleanly.
 *      Per locked decision #1: the field is a positive integer
 *      validated at schema time + DB-side CHECK as honest backstop.
 *
 *   2. PAGAMENTOS — reshape IntencaoPagamento into multi-item cart
 *      ──────────────────────────────────────────────────────────
 *      The IntencaoPagamento today carries a single `idContribuicao`
 *      at root + the entire SnapshotComposicaoValores as a single
 *      JSONB blob (`intencao_composicao_valores`). Post-0016 the
 *      cart-shape replaces that: root carries the aggregate snapshot
 *      (sum across items) + `idCampanha` (the cart-scope invariant
 *      carrier); the per-line composição moves to the new
 *      `intencao_items` table.
 *
 *      Drops (per operator review lock #16 — pure drop, no synthetic
 *      backfill; staging is throwaway):
 *        - intencao_id_contribuicao (moves to per-item)
 *        - intencao_composicao_valores (JSONB blob — replaced by
 *          per-item rows + the new aggregate cents columns)
 *        - pagamentos_intencao_id_contribuicao_idx (migration 011)
 *        - pagamentos_aprovado_por_contribuicao_idx (migration 019 —
 *          replaced by the new partial index on intencao_items)
 *
 *      Renames:
 *        - intencao_amount_cents → intencao_total_paid_cents
 *          (clearer semantics: this is the aggregate total the buyer
 *          paid across all items in the cart)
 *
 *      Adds:
 *        - intencao_total_contribution_cents BIGINT NOT NULL
 *        - intencao_total_fee_cents BIGINT NOT NULL
 *        - intencao_total_receiver_cents BIGINT NOT NULL
 *        - intencao_total_surcharge_cents BIGINT NOT NULL
 *          (aggregate snapshot — sum across items, denormalised at
 *          intent-creation for read-path simplicity)
 *        - intencao_id_campanha UUID NOT NULL REFERENCES campanhas(id)
 *          (the cart's recebedor-scope invariant — all items in a
 *          cart share the same campanha)
 *
 *   3. INTENCAO_ITEMS — new table for per-item decomposition
 *      ──────────────────────────────────────────────────────
 *      Items live in their own table (not JSONB on pagamentos) per
 *      operator review lock #15 — the `quantidadeRestante` query
 *      GROUP BYs by `id_contribuicao` across all aprovado items;
 *      JSONB would lose indexability for that hot path.
 *
 *      Discriminated by `tipo` — 'contribuicao' or 'passthrough_surcharge'.
 *      DB-side CHECK constraint enforces the discriminator invariants
 *      as honest backstop (per locked decision #7); the entity layer
 *      also validates.
 *
 *      Two indexes:
 *        - idx_intencao_items_contribuicao_aprovado: partial index on
 *          id_contribuicao INCLUDE (quantidade) WHERE id_contribuicao
 *          IS NOT NULL. Feeds the quantidadeRestante query (joined
 *          against pagamentos.status='aprovado'). Partial because
 *          surcharge items have no id_contribuicao.
 *        - idx_intencao_items_pagamento_position: composite on
 *          (id_pagamento, position). Feeds the per-pagamento item
 *          iteration for the lançamento factory + admin UI.
 *
 *      UNIQUE (id_pagamento, position) enforces position-stability —
 *      no two items in the same pagamento share a position. The
 *      caller-controlled position convention (contribuição items
 *      first in caller-provided order; surcharge item ALWAYS LAST
 *      per operator review lock #18) is application-layer, but the
 *      uniqueness is structural.
 *
 * `lancamentos_financeiros`: NO schema change. The factory output
 * rate per pagamento changes (`2N + S` instead of `2 + (1 if cartao)`)
 * but per-row shape is identical.
 *
 * Backfill / data-preservation: NONE. Operator confirmed staging is
 * throwaway data; the asymmetric `surchargeCents` field at pagamento
 * level retires. Existing rows lose their per-line composição shape
 * post-migration — the JSONB blob is dropped without synthetic-row
 * insertion into intencao_items. Staging will lose visibility into
 * the items shape of pre-migration pagamentos; that's accepted per
 * operator review lock #16.
 *
 * NOTE on schema drift from plan §Phase 0: the plan brief lists
 * individual composição cents columns (intencao_contribution_amount_cents,
 * intencao_fee_amount_cents, etc.) being dropped. Those never existed
 * as separate columns — the composição has lived as a single JSONB
 * blob (`intencao_composicao_valores`) since migration 011. The
 * end-state shape after this migration is identical to the plan's
 * stated objective; only the verb on the JSONB column differs ("drop
 * blob" vs "drop individual columns").
 *
 * Reversibility: down() re-creates the dropped columns + indexes
 * + JSONB blob structurally identical to pre-022 shape. It does NOT
 * restore data — same shape as the 019 collapse migration: a
 * downgrade is paired with a separate data-restoration step if any
 * data needs to survive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ──────────────────────────────────────────────────────────────────
  // (1) CONTRIBUIÇÕES — add quantidade
  // ──────────────────────────────────────────────────────────────────

  await sql`
    ALTER TABLE contribuicoes
      ADD COLUMN quantidade INTEGER NOT NULL DEFAULT 1
  `.execute(db);

  await sql`
    ALTER TABLE contribuicoes
      ADD CONSTRAINT contribuicoes_quantidade_positive_check
      CHECK (quantidade >= 1)
  `.execute(db);

  // ──────────────────────────────────────────────────────────────────
  // (2) PAGAMENTOS — reshape into multi-item cart shape
  // ──────────────────────────────────────────────────────────────────

  // Drop the indexes that reference soon-to-be-dropped columns. The
  // partial index from 019 is functionally replaced by the new partial
  // index on intencao_items (created below); the b-tree from 011 is
  // simply orphaned by the column drop.
  await sql`DROP INDEX IF EXISTS pagamentos_aprovado_por_contribuicao_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS pagamentos_intencao_id_contribuicao_idx`.execute(db);

  // Drop the single-item composição blob + the root idContribuicao —
  // both move to per-item.
  await db.schema
    .alterTable('pagamentos')
    .dropColumn('intencao_composicao_valores')
    .dropColumn('intencao_id_contribuicao')
    .execute();

  // Rename the totalPaid carrier for clarity.
  await sql`
    ALTER TABLE pagamentos
      RENAME COLUMN intencao_amount_cents TO intencao_total_paid_cents
  `.execute(db);

  // Widen totalPaid to bigint while we're here — the aggregate columns
  // below are bigint to match the per-line columns on intencao_items;
  // keeping totalPaid as integer would create a casting inconsistency
  // in the read-path aggregation query.
  await sql`
    ALTER TABLE pagamentos
      ALTER COLUMN intencao_total_paid_cents TYPE bigint
  `.execute(db);

  // Add the aggregate snapshot columns + the cart-scope invariant FK.
  // All NOT NULL — every IntencaoPagamento has an aggregate snapshot
  // at construction time + belongs to exactly one campanha. Per
  // operator review lock #16 there is no backfill; existing rows
  // get filled via the application-layer drop-and-restart on staging.
  //
  // We add as NULLABLE first to keep this single transaction valid
  // against any surviving rows on staging, then SET NOT NULL after
  // dropping anything that hasn't been hand-stitched.  Per operator
  // review lock #16 the migration is pure drop on a throwaway DB,
  // so the simplest path is: add NULLABLE, delete any pre-migration
  // pagamentos that would violate the NOT NULL (staging-only),
  // then SET NOT NULL.
  await sql`
    ALTER TABLE pagamentos
      ADD COLUMN intencao_total_contribution_cents bigint,
      ADD COLUMN intencao_total_fee_cents          bigint,
      ADD COLUMN intencao_total_receiver_cents     bigint,
      ADD COLUMN intencao_total_surcharge_cents    bigint,
      ADD COLUMN intencao_id_campanha              uuid
  `.execute(db);

  // Drop any surviving pre-migration pagamentos rows that can't carry
  // the new NOT NULL shape (operator review lock #16: staging is
  // throwaway; no preservation logic). Cascades into:
  //   - intencao_items (new table; empty pre-migration so no-op)
  //   - lancamentos_financeiros (id_pagamento FK — but those have
  //     no ON DELETE CASCADE today; we delete them explicitly first)
  //   - payment_webhook_events (pagamento_id NULL on delete; covered)
  //   - repasses_recebedor (id-list table; covered)
  //
  // No safety check for "did we delete anything useful?" — staging.
  await sql`DELETE FROM lancamentos_financeiros`.execute(db);
  await sql`DELETE FROM payment_webhook_events`.execute(db);
  await sql`DELETE FROM pagamentos`.execute(db);

  // Now safe to flip the new columns to NOT NULL + add the FK.
  await sql`
    ALTER TABLE pagamentos
      ALTER COLUMN intencao_total_contribution_cents SET NOT NULL,
      ALTER COLUMN intencao_total_fee_cents          SET NOT NULL,
      ALTER COLUMN intencao_total_receiver_cents     SET NOT NULL,
      ALTER COLUMN intencao_total_surcharge_cents    SET NOT NULL,
      ALTER COLUMN intencao_id_campanha              SET NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE pagamentos
      ADD CONSTRAINT pagamentos_intencao_id_campanha_fk
      FOREIGN KEY (intencao_id_campanha) REFERENCES campanhas(id)
  `.execute(db);

  // ──────────────────────────────────────────────────────────────────
  // (3) INTENCAO_ITEMS — new table
  // ──────────────────────────────────────────────────────────────────

  await sql`
    CREATE TABLE intencao_items (
      id UUID PRIMARY KEY,
      id_pagamento UUID NOT NULL REFERENCES pagamentos(id) ON DELETE CASCADE,
      id_intencao_pagamento UUID NOT NULL,
      position INTEGER NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('contribuicao', 'passthrough_surcharge')),
      id_contribuicao UUID NULL REFERENCES contribuicoes(id),
      quantidade INTEGER NOT NULL CHECK (quantidade >= 1),
      -- composição (contribuicao tipo): all six fields NULL when tipo='passthrough_surcharge'
      contribution_unit_amount_cents BIGINT NULL,
      fee_unit_amount_cents          BIGINT NULL,
      receiver_unit_amount_cents     BIGINT NULL,
      line_contribution_amount_cents BIGINT NULL,
      line_fee_amount_cents          BIGINT NULL,
      line_receiver_amount_cents     BIGINT NULL,
      -- composição (passthrough_surcharge tipo): set when tipo='passthrough_surcharge', NULL otherwise
      surcharge_amount_cents BIGINT NULL,
      criado_em TIMESTAMPTZ NOT NULL,
      -- Discriminator integrity (DB-side backstop; entity also validates)
      CONSTRAINT intencao_items_discriminator_shape_check CHECK (
        (
          tipo = 'contribuicao'
          AND id_contribuicao IS NOT NULL
          AND contribution_unit_amount_cents IS NOT NULL
          AND fee_unit_amount_cents          IS NOT NULL
          AND receiver_unit_amount_cents     IS NOT NULL
          AND line_contribution_amount_cents IS NOT NULL
          AND line_fee_amount_cents          IS NOT NULL
          AND line_receiver_amount_cents     IS NOT NULL
          AND surcharge_amount_cents IS NULL
        )
        OR
        (
          tipo = 'passthrough_surcharge'
          AND id_contribuicao IS NULL
          AND surcharge_amount_cents IS NOT NULL
          AND contribution_unit_amount_cents IS NULL
          AND fee_unit_amount_cents          IS NULL
          AND receiver_unit_amount_cents     IS NULL
          AND line_contribution_amount_cents IS NULL
          AND line_fee_amount_cents          IS NULL
          AND line_receiver_amount_cents     IS NULL
        )
      ),
      CONSTRAINT intencao_items_pagamento_position_uniq UNIQUE (id_pagamento, position)
    )
  `.execute(db);

  // Index for the quantidadeRestante query — joined against
  // pagamentos.status='aprovado', filtered by id_contribuicao,
  // summed on quantidade. INCLUDE (quantidade) makes it a covering
  // index for the SUM aggregation. Partial because surcharge items
  // (id_contribuicao IS NULL) never participate in this query.
  await sql`
    CREATE INDEX idx_intencao_items_contribuicao_aprovado
      ON intencao_items (id_contribuicao)
      INCLUDE (quantidade)
      WHERE id_contribuicao IS NOT NULL
  `.execute(db);

  // Index for per-pagamento iteration — admin UI, lançamento factory.
  // Composite on (id_pagamento, position) matches the typical
  // "ORDER BY position" iteration pattern.
  await sql`
    CREATE INDEX idx_intencao_items_pagamento_position
      ON intencao_items (id_pagamento, position)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse order of up() — drop intencao_items, then unwind pagamentos
  // reshape, then drop contribuicoes.quantidade.

  // ──────────────────────────────────────────────────────────────────
  // (3) INTENCAO_ITEMS — drop the table + indexes
  // ──────────────────────────────────────────────────────────────────

  await sql`DROP INDEX IF EXISTS idx_intencao_items_pagamento_position`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_intencao_items_contribuicao_aprovado`.execute(db);
  await sql`DROP TABLE IF EXISTS intencao_items`.execute(db);

  // ──────────────────────────────────────────────────────────────────
  // (2) PAGAMENTOS — restore single-item shape
  // ──────────────────────────────────────────────────────────────────

  await sql`
    ALTER TABLE pagamentos
      DROP CONSTRAINT IF EXISTS pagamentos_intencao_id_campanha_fk
  `.execute(db);

  await sql`
    ALTER TABLE pagamentos
      DROP COLUMN intencao_id_campanha,
      DROP COLUMN intencao_total_surcharge_cents,
      DROP COLUMN intencao_total_receiver_cents,
      DROP COLUMN intencao_total_fee_cents,
      DROP COLUMN intencao_total_contribution_cents
  `.execute(db);

  // Restore the int4 type + the original column name.
  await sql`
    ALTER TABLE pagamentos
      ALTER COLUMN intencao_total_paid_cents TYPE integer
  `.execute(db);

  await sql`
    ALTER TABLE pagamentos
      RENAME COLUMN intencao_total_paid_cents TO intencao_amount_cents
  `.execute(db);

  // Re-add the dropped columns as NULLABLE first, backfill placeholders
  // (an empty JSONB object + a zero UUID — same can't-be-restored
  // pattern as 019's contribuinte fields), then SET NOT NULL.
  await sql`
    ALTER TABLE pagamentos
      ADD COLUMN intencao_id_contribuicao uuid,
      ADD COLUMN intencao_composicao_valores jsonb
  `.execute(db);

  await sql`
    UPDATE pagamentos
      SET intencao_id_contribuicao = '00000000-0000-0000-0000-000000000000',
          intencao_composicao_valores = '{}'::jsonb
      WHERE intencao_id_contribuicao IS NULL
  `.execute(db);

  await sql`
    ALTER TABLE pagamentos
      ALTER COLUMN intencao_id_contribuicao SET NOT NULL,
      ALTER COLUMN intencao_composicao_valores SET NOT NULL
  `.execute(db);

  // Restore the indexes from migrations 011 + 019.
  await sql`
    CREATE INDEX pagamentos_intencao_id_contribuicao_idx
      ON pagamentos (intencao_id_contribuicao)
  `.execute(db);

  await sql`
    CREATE INDEX pagamentos_aprovado_por_contribuicao_idx
      ON pagamentos (intencao_id_contribuicao)
      WHERE status = 'aprovado'
  `.execute(db);

  // ──────────────────────────────────────────────────────────────────
  // (1) CONTRIBUIÇÕES — drop quantidade
  // ──────────────────────────────────────────────────────────────────

  await sql`
    ALTER TABLE contribuicoes
      DROP CONSTRAINT IF EXISTS contribuicoes_quantidade_positive_check
  `.execute(db);

  await db.schema.alterTable('contribuicoes').dropColumn('quantidade').execute();
}
