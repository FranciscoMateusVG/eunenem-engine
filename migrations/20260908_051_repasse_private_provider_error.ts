import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Private, bounded Banco Inter error evidence for payout attempts.
 *
 * Historical rows remain NULL. New non-2xx PIX responses are closed into
 * the existing attempt transaction with at most 16 KiB of decoded UTF-8.
 * The body is intentionally private admin data and must never be copied to
 * logs, spans, public DTOs, or model-visible diagnostics.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('repasse_transfer_attempts')
    .addColumn('provider_error_body_private', 'text')
    .addColumn('provider_error_body_truncated', 'boolean')
    .execute();

  await sql`
    ALTER TABLE repasse_transfer_attempts
      ADD CONSTRAINT repasse_attempt_private_error_pair_check
        CHECK (
          (provider_error_body_private IS NULL AND provider_error_body_truncated IS NULL)
          OR
          (
            provider_error_body_private IS NOT NULL
            AND provider_error_body_truncated IS NOT NULL
            AND octet_length(provider_error_body_private) <= 16384
          )
        )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('repasse_transfer_attempts')
    .dropColumn('provider_error_body_truncated')
    .dropColumn('provider_error_body_private')
    .execute();
}
