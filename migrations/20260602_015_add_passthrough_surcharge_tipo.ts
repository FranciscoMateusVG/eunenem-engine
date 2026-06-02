import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Extend `lancamentos_financeiros.tipo` CHECK constraint to include the
 * new `credito_passthrough_surcharge` literal (aperture-bjshv,
 * Finding (1) of epic aperture-9erfv).
 *
 * Background: migration 20260531_012 declared the CHECK constraint as
 * an enumeration of the two original tipo values
 * (`credito_saldo_recebedor`, `credito_receita_plataforma`). Inserting
 * a row with the new `credito_passthrough_surcharge` literal raises
 * `lancamentos_financeiros_tipo_check`. This migration drops + recreates
 * the constraint with the third literal added so cartao pagamentos can
 * book their buyer-paid surcharge.
 *
 * Postgres CHECK constraints can't be ALTERED in place — drop + recreate
 * is the canonical pattern. Both operations are metadata-only on an
 * empty or modest table; on large populated tables the recreate scans
 * existing rows to validate the new predicate (fast here — all current
 * rows already satisfy the broader enum since `passthrough` is strictly
 * new).
 *
 * Forward-only per epic. No data backfill: historical aprovados from
 * before bjshv keep their 2-lancamento book entries. The R$ amounts
 * that previously leaked are NOT retroactively booked. Operator
 * accepted the gap per epic aperture-9erfv acceptance criterion (i).
 *
 * Down-migration narrows the constraint back to the original two
 * literals. After bjshv ships, that down would fail on any row that
 * carries the new tipo — Postgres surfaces a clear CHECK-validation
 * error in that case (no need for a pre-flight guard here; the error
 * names the constraint and the offending value).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop the old constraint (added in migration 012). The CONSTRAINT
  // name is matched verbatim from `lancamentos_financeiros_tipo_check`.
  await sql`
    ALTER TABLE lancamentos_financeiros
      DROP CONSTRAINT lancamentos_financeiros_tipo_check
  `.execute(db);

  await sql`
    ALTER TABLE lancamentos_financeiros
      ADD CONSTRAINT lancamentos_financeiros_tipo_check
      CHECK (tipo IN (
        'credito_saldo_recebedor',
        'credito_receita_plataforma',
        'credito_passthrough_surcharge'
      ))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE lancamentos_financeiros
      DROP CONSTRAINT lancamentos_financeiros_tipo_check
  `.execute(db);

  // Narrowing back. If any row carries 'credito_passthrough_surcharge',
  // Postgres rejects the constraint with a clear error naming the
  // offending value — sufficient signal for the operator without a
  // separate pre-flight COUNT.
  await sql`
    ALTER TABLE lancamentos_financeiros
      ADD CONSTRAINT lancamentos_financeiros_tipo_check
      CHECK (tipo IN (
        'credito_saldo_recebedor',
        'credito_receita_plataforma'
      ))
  `.execute(db);
}
