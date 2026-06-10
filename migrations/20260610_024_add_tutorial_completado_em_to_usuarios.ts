import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Plan 0018 Phase A (aperture-omswg). First-time tutorial overlay.
 *
 * Adds `usuarios.tutorial_completado_em TIMESTAMPTZ NULL`. The column
 * encodes BOTH the boolean predicate ("has this user completed the
 * tutorial?") AND the moment they did via a single NULL-vs-non-NULL
 * shape:
 *
 *   - NULL      → first-time user, overlay fires on next visit
 *   - non-NULL  → tutorial completed; the timestamp is the moment they
 *                 either clicked "skip", finished the last step, or had
 *                 the system mark them complete (admin tools, future
 *                 backfill, etc).
 *
 * Default NULL — every existing usuario is implicitly a first-time
 * user post-migration. Operator-aware: this means every active session
 * sees the overlay on their next page load; the frontend gates it with
 * a single "shown=true" client-side flag if needed during the
 * roll-forward window.
 *
 * Idempotent shape at the use-case layer: `marcarTutorialUsuarioComoCompletado`
 * is a no-op when the column is already non-NULL — the original timestamp
 * is preserved (first-write-wins). This matches the visitor-side
 * contribuinte-projection precedent and lets the frontend fire-and-forget
 * the mark mutation on every "skip" / "finish" click without race
 * concerns.
 *
 * Reversibility: down() drops the column. No data preservation (the
 * column carries derived state — it can be re-derived from a future
 * backfill).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE usuarios
      ADD COLUMN tutorial_completado_em TIMESTAMPTZ NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE usuarios
      DROP COLUMN tutorial_completado_em
  `.execute(db);
}
