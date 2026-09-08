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
 * closed if any expected predicate differs. Attempt history is never changed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
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
      target_matches boolean;
    BEGIN
      SELECT EXISTS (
        SELECT 1 FROM repasses_recebedor WHERE id = 'e2c18fc0-a5f9-4d23-a0e7-104b68327b57'::uuid
      ) INTO target_exists;

      IF NOT target_exists THEN
        RETURN;
      END IF;

      SELECT EXISTS (
        SELECT 1
          FROM repasses_recebedor r
          JOIN repasse_transfer_attempts a
            ON a.repasse_id = r.id AND a.attempt_no = 4
          WHERE r.id = 'e2c18fc0-a5f9-4d23-a0e7-104b68327b57'::uuid
            AND r.status = 'verificando'
            AND a.finished_at IS NOT NULL
            AND a.http_status = 200
            AND a.outcome = 'agendado_aprovacao'
            AND a.codigo_solicitacao IS NOT NULL
            AND length(btrim(a.codigo_solicitacao)) > 0
            AND r.inter_codigo_solicitacao = a.codigo_solicitacao
            AND NOT EXISTS (
              SELECT 1
                FROM lancamentos_financeiros l
                WHERE l.id_repasse = r.id
                  AND l.transferido_em IS NOT NULL
            )
      ) INTO target_matches;

      IF NOT target_matches THEN
        RAISE EXCEPTION 'operator-authorized payout handoff target does not match guarded predicates';
      END IF;

      UPDATE repasses_recebedor r
        SET status = 'enviado_ao_banco',
            enviado_ao_banco_em = a.finished_at,
            last_transfer_error = NULL,
            needs_manual_resolution = FALSE
        FROM repasse_transfer_attempts a
        WHERE r.id = 'e2c18fc0-a5f9-4d23-a0e7-104b68327b57'::uuid
          AND a.repasse_id = r.id
          AND a.attempt_no = 4;
    END
    $handoff$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE repasses_recebedor
      DROP CONSTRAINT repasses_recebedor_bank_handoff_check;

    UPDATE repasses_recebedor
      SET status = 'verificando', enviado_ao_banco_em = NULL
      WHERE status = 'enviado_ao_banco';

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
