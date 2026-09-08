import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Platform payout handoff semantics.
 *
 * `enviado_ao_banco` means Banco Inter accepted the POST and returned a
 * codigoSolicitacao. It does not mean the bank approved or settled the PIX,
 * so this migration never writes lancamentos_financeiros.transferido_em.
 *
 * The final DO block is an operator-authorized, staging-targeted correction
 * for the existing R$20 repasse whose fourth attempt already has the durable
 * acceptance receipt. It is a no-op where the target does not exist and fails
 * closed if any exact, read-only-verified predicate differs. Attempt history
 * is never changed by the forward migration.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const previousTimeouts = await sql<{
    lock_timeout: string;
    statement_timeout: string;
  }>`
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout
  `.execute(db);
  const previous = previousTimeouts.rows[0];
  if (previous === undefined) {
    throw new Error('Could not read PostgreSQL migration timeout settings');
  }

  // Bound this migration without widening an existing stricter session limit.
  // These settings are transaction-local; the production Kysely migrator runs
  // PostgreSQL migrations in one transaction. Restore them after success so
  // later migrations in the same run retain the deployment session policy.
  await sql`
    SELECT set_config(
             'lock_timeout',
             CASE
               WHEN (SELECT setting::bigint FROM pg_settings WHERE name = 'lock_timeout') = 0
                 OR (SELECT setting::bigint FROM pg_settings WHERE name = 'lock_timeout') > 5000
               THEN '5000ms'
               ELSE current_setting('lock_timeout')
             END,
             TRUE
           ),
           set_config(
             'statement_timeout',
             CASE
               WHEN (SELECT setting::bigint FROM pg_settings WHERE name = 'statement_timeout') = 0
                 OR (SELECT setting::bigint FROM pg_settings WHERE name = 'statement_timeout') > 60000
               THEN '60000ms'
               ELSE current_setting('statement_timeout')
             END,
             TRUE
           )
  `.execute(db);

  // Freeze the cross-table financial evidence for this migration transaction.
  // SHARE conflicts with INSERT/UPDATE/DELETE's ROW EXCLUSIVE lock, so a
  // concurrent worker must finish before the guarded mutation reads the ledger
  // and cannot drift it between predicate evaluation and conversion.
  await sql`LOCK TABLE lancamentos_financeiros IN SHARE MODE`.execute(db);

  await db.schema
    .alterTable('repasses_recebedor')
    .addColumn('enviado_ao_banco_em', 'timestamptz')
    .execute();

  await sql`
    ALTER TABLE repasses_recebedor
      DROP CONSTRAINT repasses_recebedor_status_check,
      ADD CONSTRAINT repasses_recebedor_status_check
        CHECK (status IN (
          'solicitado', 'aprovado', 'transferindo', 'verificando',
          'enviado_ao_banco', 'pago', 'falhou', 'cancelado'
        )),
      ADD CONSTRAINT repasses_recebedor_bank_handoff_check
        CHECK (
          status <> 'enviado_ao_banco'
          OR (
            enviado_ao_banco_em IS NOT NULL
            AND inter_codigo_solicitacao IS NOT NULL
            AND length(btrim(inter_codigo_solicitacao)) > 0
          )
        );

    ALTER TABLE repasse_transfer_attempts
      DROP CONSTRAINT repasse_attempt_state_before_check,
      DROP CONSTRAINT repasse_attempt_state_after_check,
      ADD CONSTRAINT repasse_attempt_state_before_check
        CHECK (
          state_before IS NULL OR state_before IN (
            'solicitado', 'aprovado', 'transferindo', 'verificando',
            'enviado_ao_banco', 'pago', 'falhou', 'cancelado'
          )
        ),
      ADD CONSTRAINT repasse_attempt_state_after_check
        CHECK (
          state_after IS NULL OR state_after IN (
            'solicitado', 'aprovado', 'transferindo', 'verificando',
            'enviado_ao_banco', 'pago', 'falhou', 'cancelado'
          )
        );
  `.execute(db);

  await sql`
    DO $handoff$
    DECLARE
      target_exists boolean;
      updated_count integer;
    BEGIN
      SELECT EXISTS (
        SELECT 1 FROM repasses_recebedor WHERE id = 'e2c18fc0-a5f9-4d23-a0e7-104b68327b57'::uuid
      ) INTO target_exists;

      IF NOT target_exists THEN
        RETURN;
      END IF;

      UPDATE repasses_recebedor r
        SET status = 'enviado_ao_banco',
            enviado_ao_banco_em = a.finished_at,
            last_transfer_error = NULL,
            needs_manual_resolution = FALSE
        FROM repasse_transfer_attempts a
        WHERE r.id = 'e2c18fc0-a5f9-4d23-a0e7-104b68327b57'::uuid
          AND r.amount_cents = 2000
          AND r.status = 'verificando'
          AND a.repasse_id = r.id
          AND a.attempt_no = 4
          AND a.finished_at = '2026-09-08T12:12:09.139000Z'::timestamptz
          AND a.http_status = 200
          AND a.outcome = 'verificando'
          AND a.codigo_solicitacao = '203f4559-72d8-4675-9f79-aa360b9f4456'
          AND r.inter_codigo_solicitacao = a.codigo_solicitacao
          AND NOT EXISTS (
            SELECT 1
              FROM lancamentos_financeiros l
              WHERE l.id_repasse = r.id
                AND l.transferido_em IS NOT NULL
          )
          AND (
            SELECT count(*) FROM lancamentos_financeiros l WHERE l.id_repasse = r.id
          ) = 2
          AND (
            SELECT coalesce(sum(l.amount_cents), 0)
              FROM lancamentos_financeiros l
              WHERE l.id_repasse = r.id
          ) = 2000;

      GET DIAGNOSTICS updated_count = ROW_COUNT;
      IF updated_count <> 1 THEN
        RAISE EXCEPTION 'operator-authorized payout handoff target does not match guarded predicates';
      END IF;
    END
    $handoff$;
  `.execute(db);

  await sql`
    SELECT set_config('lock_timeout', ${previous.lock_timeout}, TRUE),
           set_config('statement_timeout', ${previous.statement_timeout}, TRUE)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE repasses_recebedor
      DROP CONSTRAINT repasses_recebedor_bank_handoff_check;

    UPDATE repasses_recebedor
      SET status = 'verificando', enviado_ao_banco_em = NULL
      WHERE status = 'enviado_ao_banco';

    -- Rollback-only representational mapping. The old schema cannot encode the
    -- handoff state in attempt snapshots, so preserve the rows and their
    -- receipts/outcomes while mapping only that state label to its old-schema
    -- predecessor before reinstating the old CHECK constraints.
    UPDATE repasse_transfer_attempts
      SET state_before = CASE
            WHEN state_before = 'enviado_ao_banco' THEN 'verificando'
            ELSE state_before
          END,
          state_after = CASE
            WHEN state_after = 'enviado_ao_banco' THEN 'verificando'
            ELSE state_after
          END
      WHERE state_before = 'enviado_ao_banco'
         OR state_after = 'enviado_ao_banco';

    ALTER TABLE repasses_recebedor
      DROP CONSTRAINT repasses_recebedor_status_check,
      ADD CONSTRAINT repasses_recebedor_status_check
        CHECK (status IN (
          'solicitado', 'aprovado', 'transferindo', 'verificando',
          'pago', 'falhou', 'cancelado'
        ));

    ALTER TABLE repasse_transfer_attempts
      DROP CONSTRAINT repasse_attempt_state_before_check,
      DROP CONSTRAINT repasse_attempt_state_after_check,
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
        );
  `.execute(db);

  await db.schema.alterTable('repasses_recebedor').dropColumn('enviado_ao_banco_em').execute();
}
