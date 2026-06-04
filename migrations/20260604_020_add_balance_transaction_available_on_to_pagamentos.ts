import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Plan 0015 derived-liberação extension (aperture-mjgxe). Add
 * `intencao_balance_transaction_available_on TIMESTAMPTZ NULL` to
 * `pagamentos`.
 *
 * Operator design conversation 2026-06-04 locked: distinguish
 * "aguardando liberação" vs "disponível" sub-states of `aprovado`
 * via a derived predicate over this column — NOT a new FSM enum
 * value. The status enum stays at 5 values
 * (pendente, processing, aprovado, rejeitado, estornado); the
 * liberação predicate is computed at the DTO layer.
 *
 * Population:
 *   - PIX: webhook dispatcher sets to NOW() at
 *     `payment_intent.succeeded` (operator's no-cancel domain
 *     shortcut — pix funds settle effectively immediately).
 *   - CARTÃO: dispatcher fetches `charge.balance_transaction.available_on`
 *     from the Stripe API at `payment_intent.succeeded` and
 *     persists. Stripe test mode shows ~6 days from succeeded;
 *     prod is the configured payout schedule (typically 30d for
 *     unanticipated cards).
 *
 * Derived predicate at the DTO layer:
 *   status='aprovado' AND available_on IS NULL OR available_on > now()
 *     → aguardando_liberacao
 *   status='aprovado' AND available_on <= now()
 *     → disponivel
 *
 * No index for v1 — the column participates only in per-pagamento
 * lookups at the admin-list level which is already filtered + sorted
 * by criadoEm DESC and bounded (≤ paginated page size). If later
 * forensic queries scan by available_on, we add a partial index
 * `WHERE available_on IS NOT NULL` then.
 *
 * Nullable because:
 *   - Pre-Phase-3 + Phase-3 rows have no available_on yet (NULL)
 *   - synchronous PIX-direct topologies that don't go through
 *     a Stripe payment_intent.succeeded path stay NULL forever
 *   - Brief window between aprovado and the webhook firing is NULL
 *
 * Reversibility: down() drops the column. No data preservation —
 * the column is populated entirely by the webhook handler, so
 * dropping + re-adding loses nothing the handler can't repopulate
 * on the next event of the relevant type.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE pagamentos
      ADD COLUMN intencao_balance_transaction_available_on timestamptz
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE pagamentos
      DROP COLUMN intencao_balance_transaction_available_on
  `.execute(db);
}
