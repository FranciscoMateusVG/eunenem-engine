import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * aperture-16wrk / 5v766 Phase A. Per-pagamento read state for the
 * admin mensagens dashboard (`/painel/<slug>/mensagens`).
 *
 * Adds `pagamentos.mensagem_lida_em TIMESTAMPTZ NULL`. The column
 * encodes BOTH the boolean predicate ("has the admin read this
 * recado?") AND the moment they did via a single NULL-vs-non-NULL
 * shape:
 *
 *   - NULL      → unread; surfaces with the "nova" badge in the admin
 *                 dashboard, counted in the `naoLidas` chip
 *   - non-NULL  → read; the timestamp is the moment the admin clicked
 *                 "MARCAR LIDA" or "MARCAR TUDO COMO LIDO"
 *
 * Default NULL — every existing pagamento with a mensagem is
 * implicitly unread post-migration. The admin opens the page, sees
 * the full unread queue, marks them. No backfill — re-deriving "was
 * this seen?" from past behaviour is not meaningful.
 *
 * Idempotent shape at the use-case layer: `marcarRecadoComoLido` is
 * a no-op when the column is already non-NULL — the original
 * timestamp is preserved (first-write-wins). Same posture as the
 * tutorial-completado-em column from aperture-omswg and the
 * visitor-side contribuinte-projection precedent. Lets the frontend
 * fire-and-forget the mark mutation without race concerns.
 *
 * Index decision: NO new index. The admin dashboard query lives on
 * top of the existing visitor-mural query shape (intencao_id_campanha
 * + status = 'aprovado' + intencao_contribuinte_mensagem IS NOT NULL)
 * which is already supported by the table's natural row distribution
 * per campanha — admins page through their own recados only. Per-
 * campanha cardinality is in the hundreds, well below any cost that
 * would justify a partial index. Re-evaluate when one campanha
 * crosses ~10k recados.
 *
 * Reversibility: down() drops the column. No data preservation (the
 * column carries derived "did the admin see this?" state — not
 * recoverable post-drop, but the admin can re-mark on the next
 * session if needed).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE pagamentos
      ADD COLUMN mensagem_lida_em TIMESTAMPTZ NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE pagamentos
      DROP COLUMN mensagem_lida_em
  `.execute(db);
}
