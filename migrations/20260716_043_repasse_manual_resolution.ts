import type { Kysely } from 'kysely';

/**
 * aperture-477nz — Inter repasse reconciliation fallback (Part B).
 *
 * When the executar handler crashes AFTER the PIX left but BEFORE it
 * captured Inter's codigoSolicitacao, the confirmar handler reconciles via
 * buscarPagamentos (an extrato search). Inter's API exposes NO reliable
 * caller-supplied identifier in the extrato (only the server-generated
 * codigoSolicitacao round-trips), so a search match CANNOT be proven to be
 * OUR payment at the adapter boundary. Per the GLaDOS-decided policy:
 *
 *  - ZERO candidates sustained across the FULL ~48h escalation window →
 *    auto-`falhou` (48h of extrato absence is real evidence of no payment).
 *  - ONE+ candidates at ANY point → the repasse STAYS `verificando` and is
 *    FLAGGED `needs_manual_resolution`; the candidate rows are persisted for
 *    an admin to inspect and resolve manually. A search match NEVER
 *    auto-books `pago` — that is the double-settlement door this closes.
 *
 * The two admin escape hatches (resolverManualPago / resolverManualFalhou)
 * are legal ONLY from the verificando + needs_manual_resolution state.
 *
 * PII: `chave_mascarada` stores the recipient chave in MASKED form only —
 * never the full chave at rest (Cipher gate). Candidate rows carry no CPF /
 * name.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  // ───── repasses_recebedor: the manual-resolution flag ─────
  await db.schema
    .alterTable('repasses_recebedor')
    // TRUE ⇒ a verificando repasse whose search reconciliation found
    // candidate payment(s) that cannot be auto-confirmed as ours; awaiting
    // an admin's manual pago/falhou decision. Cleared on resolution.
    .addColumn('needs_manual_resolution', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();

  // ───── repasse_reconciliacao_candidatos: persisted search candidates ─────
  await db.schema
    .createTable('repasse_reconciliacao_candidatos')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('repasse_id', 'uuid', (col) => col.notNull())
    // Inter's server-generated payment id — this is what an admin copies into
    // resolverManualPago to book the payment (it is the stable Inter handle).
    .addColumn('codigo_solicitacao', 'text', (col) => col.notNull())
    .addColumn('valor_cents', 'integer', (col) => col.notNull())
    .addColumn('data_movimento', 'text')
    // MASKED recipient chave only (e.g. "j***@e***.com" / "***.***.***-12").
    // The full chave is NEVER persisted here (Cipher gate).
    .addColumn('chave_mascarada', 'text')
    .addColumn('descricao_pix', 'text')
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull())
    .addForeignKeyConstraint(
      'repasse_reconciliacao_candidatos_repasse_id_fk',
      ['repasse_id'],
      'repasses_recebedor',
      ['id'],
    )
    // Idempotency: a re-run of the search for the same repasse must not
    // double-insert the same Inter payment as a candidate.
    .addUniqueConstraint('repasse_reconciliacao_candidatos_repasse_codigo_uniq', [
      'repasse_id',
      'codigo_solicitacao',
    ])
    .execute();

  await db.schema
    .createIndex('repasse_reconciliacao_candidatos_repasse_id_idx')
    .on('repasse_reconciliacao_candidatos')
    .column('repasse_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('repasse_reconciliacao_candidatos').execute();
  await db.schema.alterTable('repasses_recebedor').dropColumn('needs_manual_resolution').execute();
}
