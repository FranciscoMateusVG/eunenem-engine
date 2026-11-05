import { type Kysely, sql } from 'kysely';

/**
 * aperture-mno2s — allow the audit row written by the "Enviar pelo Inter
 * agora" admin action (operation = 'reenvio_inter').
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE repasse_transfer_attempts
      DROP CONSTRAINT repasse_attempt_operation_check,
      ADD CONSTRAINT repasse_attempt_operation_check
        CHECK (operation IS NULL OR operation IN ('pagar_pix', 'cancelar', 'resolver_manual', 'reenvio_inter'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM repasse_transfer_attempts WHERE operation = 'reenvio_inter'`.execute(db);
  await sql`
    ALTER TABLE repasse_transfer_attempts
      DROP CONSTRAINT repasse_attempt_operation_check,
      ADD CONSTRAINT repasse_attempt_operation_check
        CHECK (operation IS NULL OR operation IN ('pagar_pix', 'cancelar', 'resolver_manual'))
  `.execute(db);
}
