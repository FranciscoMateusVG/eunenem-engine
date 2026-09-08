import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Safe, durable provider diagnostics on the existing payout-attempt trail.
 *
 * Every column is nullable so historical attempts remain truthful: absence
 * means the older code did not observe the datum. No migration invents a
 * provider cause for the existing HTTP_400 record. New attempts populate the
 * fields inside the same transaction that closes the attempt and advances the
 * repasse FSM.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('repasse_transfer_attempts')
    .addColumn('operation', 'text')
    .addColumn('http_status', 'smallint')
    .addColumn('provider_request_id', 'varchar(128)')
    .addColumn('response_class', 'text')
    .addColumn('diagnostic_code', 'text')
    .addColumn('diagnostic_field', 'text')
    .addColumn('diagnostic_reason', 'text')
    .addColumn('duration_ms', 'integer')
    .addColumn('state_before', 'text')
    .addColumn('state_after', 'text')
    .execute();

  await sql`
    ALTER TABLE repasse_transfer_attempts
      ADD CONSTRAINT repasse_attempt_operation_check
        CHECK (operation IS NULL OR operation IN ('pagar_pix', 'cancelar', 'resolver_manual')),
      ADD CONSTRAINT repasse_attempt_http_status_check
        CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
      ADD CONSTRAINT repasse_attempt_provider_request_id_check
        CHECK (
          provider_request_id IS NULL OR
          provider_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        ),
      ADD CONSTRAINT repasse_attempt_response_class_check
        CHECK (
          response_class IS NULL OR response_class IN (
            'accepted', 'validation_rejection', 'ambiguous_http',
            'pre_send_failure', 'ambiguous_transport', 'invalid_response',
            'local_rejection', 'diagnostic_unavailable'
          )
        ),
      ADD CONSTRAINT repasse_attempt_diagnostic_code_check
        CHECK (
          diagnostic_code IS NULL OR diagnostic_code IN (
            'invalid_pix_key', 'invalid_amount', 'invalid_description',
            'invalid_recipient', 'invalid_request', 'provider_rejection',
            'recipient_not_pix', 'missing_reference', 'diagnostic_unavailable'
          )
        ),
      ADD CONSTRAINT repasse_attempt_diagnostic_field_check
        CHECK (
          diagnostic_field IS NULL OR diagnostic_field IN (
            'pix_key', 'amount', 'description', 'recipient'
          )
        ),
      ADD CONSTRAINT repasse_attempt_diagnostic_reason_check
        CHECK (
          diagnostic_reason IS NULL OR diagnostic_reason IN (
            'required', 'invalid_format', 'out_of_range', 'not_owned',
            'unsupported', 'diagnostic_unavailable'
          )
        ),
      ADD CONSTRAINT repasse_attempt_duration_ms_check
        CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 120000),
      ADD CONSTRAINT repasse_attempt_state_before_check
        CHECK (
          state_before IS NULL OR state_before IN (
            'solicitado', 'aprovado', 'transferindo', 'verificando',
            'pago', 'falhou', 'cancelado'
          )
        ),
      ADD CONSTRAINT repasse_attempt_state_after_check
        CHECK (
          state_after IS NULL OR state_after IN (
            'solicitado', 'aprovado', 'transferindo', 'verificando',
            'pago', 'falhou', 'cancelado'
          )
        )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('repasse_transfer_attempts')
    .dropColumn('state_after')
    .dropColumn('state_before')
    .dropColumn('duration_ms')
    .dropColumn('diagnostic_reason')
    .dropColumn('diagnostic_field')
    .dropColumn('diagnostic_code')
    .dropColumn('response_class')
    .dropColumn('provider_request_id')
    .dropColumn('http_status')
    .dropColumn('operation')
    .execute();
}
