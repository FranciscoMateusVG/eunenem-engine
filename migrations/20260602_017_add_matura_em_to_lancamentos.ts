import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Add `matura_em timestamptz NOT NULL` to `lancamentos_financeiros`
 * + partial index optimised for `findPendentesMaturos`
 * (aperture-led0r, Finding (2) of epic aperture-9erfv).
 *
 * Backfill choice — Option X (matura_em = criado_em):
 *   Treats historical rows as already matured (regardless of method).
 *   Pros: simple, no cross-BC method lookup needed. Cons: cosmetically
 *   wrong — a 5-day-old cartao lancamento "matured" instantly per the
 *   data, when reality is 25 days from real maturation. Since most of
 *   these rows are already `disponivel` (the Finding #2 bug this fixes
 *   going forward), the UI semantics are unaffected. The data-side
 *   correction for receita_plataforma rows incorrectly at `disponivel`
 *   is a SEPARATE follow-up bead — operator dry-run review before
 *   apply, NOT part of led0r.
 *
 * Partial index `lancamentos_pendentes_maturos_idx ON (matura_em)
 * WHERE status='pendente'`:
 *   Optimised for the eager-projection query
 *   `WHERE status='pendente' AND matura_em <= now()`. Partial because
 *   the predicate is the hot path — most queries care only about
 *   pendente rows; disponivel rows accumulate but never satisfy the
 *   predicate. Partial index stays small as data grows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Phase 1: add the column NULLABLE so the backfill UPDATE works on
  // existing rows (Postgres can't add a NOT NULL column without a
  // default OR a pre-populated value).
  await sql`
    ALTER TABLE lancamentos_financeiros
      ADD COLUMN matura_em timestamptz
  `.execute(db);

  // Phase 2: backfill — Option X. matura_em = criado_em on every
  // existing row. Single UPDATE; runs against whatever rows exist at
  // migration time (typically a handful in dev, modest count in prod).
  await sql`
    UPDATE lancamentos_financeiros
      SET matura_em = criado_em
      WHERE matura_em IS NULL
  `.execute(db);

  // Phase 3: flip the column to NOT NULL now that every row has a
  // value. New INSERTs from the led0r factory will always carry
  // matura_em explicitly.
  await sql`
    ALTER TABLE lancamentos_financeiros
      ALTER COLUMN matura_em SET NOT NULL
  `.execute(db);

  // Partial index — see header for rationale.
  await sql`
    CREATE INDEX lancamentos_pendentes_maturos_idx
      ON lancamentos_financeiros (matura_em)
      WHERE status = 'pendente'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS lancamentos_pendentes_maturos_idx`.execute(db);
  await sql`
    ALTER TABLE lancamentos_financeiros
      DROP COLUMN matura_em
  `.execute(db);
}
