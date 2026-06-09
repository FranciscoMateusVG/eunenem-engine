import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2). Schema follow-up the Phase 0 plan
 * missed: `lancamentos_financeiros` needs a per-item link.
 *
 * Pre-0016 the lançamento factory emitted 2-3 rows per pagamento (one of
 * each tipo), and a UNIQUE constraint on `(id_pagamento, tipo)` enforced
 * "no double-emit per pagamento". Post-0016 the factory iterates over
 * `intencao_items` and emits per-item rows: each contribuicao-tipo item
 * produces 2 lançamentos (recebedor + receita) and each
 * passthrough_surcharge item produces 1 (passthrough). A 3-contribuição +
 * 1-surcharge cart emits 7 rows, half of which share the same
 * `(id_pagamento, tipo)` pair — the old constraint is incompatible.
 *
 * This migration:
 *   1. Adds `id_item_pagamento UUID NULL REFERENCES intencao_items(id)
 *      ON DELETE CASCADE` — the FK back to the item this lançamento
 *      represents. CASCADE so that deleting the parent pagamento (and
 *      its items via the existing cascade) cleans up its lançamentos
 *      transitively.
 *   2. Wipes the existing rows (staging-only — same throwaway-data rule
 *      as Phase 0; no data preservation).
 *   3. Drops the pre-0016 `lancamentos_financeiros_id_pagamento_tipo_uniq`
 *      constraint.
 *   4. SET NOT NULL on `id_item_pagamento` (every new lançamento MUST
 *      point at an item; this is the post-0016 invariant).
 *   5. Adds `lancamentos_financeiros_id_item_pagamento_tipo_uniq` as the
 *      replacement constraint — at most one lançamento of each tipo per
 *      item (contribuicao items have 2 distinct tipos; surcharge items
 *      have 1).
 *   6. Adds a btree index on `id_item_pagamento` for the per-item lookup
 *      surface (used by admin UI's lançamento-per-item drill-down).
 *
 * Reversibility: down() drops the new column + index + constraint and
 * restores the pre-0016 (id_pagamento, tipo) uniqueness. As with Phase 0,
 * it does NOT restore data — paired with a separate data-restoration
 * step if needed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // (1) Add the new column as NULL first — populates as NULL for any
  //     pre-migration rows (none expected on staging; the DELETE in step
  //     (2) wipes them anyway).
  await sql`
    ALTER TABLE lancamentos_financeiros
      ADD COLUMN id_item_pagamento uuid
      REFERENCES intencao_items(id) ON DELETE CASCADE
  `.execute(db);

  // (2) Pure drop — no preservation. Staging-only invariant.
  await sql`DELETE FROM lancamentos_financeiros`.execute(db);

  // (3) Drop the old (id_pagamento, tipo) uniqueness.
  await sql`
    ALTER TABLE lancamentos_financeiros
      DROP CONSTRAINT IF EXISTS lancamentos_financeiros_id_pagamento_tipo_uniq
  `.execute(db);

  // (4) SET NOT NULL — the column was NULL-add'd then table emptied;
  //     this is safe now.
  await sql`
    ALTER TABLE lancamentos_financeiros
      ALTER COLUMN id_item_pagamento SET NOT NULL
  `.execute(db);

  // (5) New uniqueness: at most one lançamento of each tipo per item.
  await sql`
    ALTER TABLE lancamentos_financeiros
      ADD CONSTRAINT lancamentos_financeiros_id_item_pagamento_tipo_uniq
      UNIQUE (id_item_pagamento, tipo)
  `.execute(db);

  // (6) Lookup index for per-item drill-downs (admin UI + audit).
  await sql`
    CREATE INDEX lancamentos_financeiros_id_item_pagamento_idx
      ON lancamentos_financeiros (id_item_pagamento)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse order.

  await sql`DROP INDEX IF EXISTS lancamentos_financeiros_id_item_pagamento_idx`.execute(db);

  await sql`
    ALTER TABLE lancamentos_financeiros
      DROP CONSTRAINT IF EXISTS lancamentos_financeiros_id_item_pagamento_tipo_uniq
  `.execute(db);

  // Allow NULL again to drop the column cleanly (matches up() ordering).
  await sql`
    ALTER TABLE lancamentos_financeiros
      ALTER COLUMN id_item_pagamento DROP NOT NULL
  `.execute(db);

  // Restore pre-0016 (id_pagamento, tipo) uniqueness for the
  // schema-shape symmetry. Wipe rows first — multi-item carts can't
  // satisfy this constraint.
  await sql`DELETE FROM lancamentos_financeiros`.execute(db);
  await sql`
    ALTER TABLE lancamentos_financeiros
      ADD CONSTRAINT lancamentos_financeiros_id_pagamento_tipo_uniq
      UNIQUE (id_pagamento, tipo)
  `.execute(db);

  await sql`
    ALTER TABLE lancamentos_financeiros
      DROP COLUMN id_item_pagamento
  `.execute(db);
}
