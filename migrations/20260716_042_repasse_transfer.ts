import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * aperture-vvh2j — Repasses automáticos via Banco Inter PIX.
 *
 * Extends the repasse FSM from `solicitado → aprovado` to the full
 * transfer lifecycle and adds the audit trail that carries the
 * double-pay-prevention invariant.
 *
 *   solicitado → aprovado → transferindo → pago
 *                                ├→ verificando → pago | falhou
 *                                └→ falhou ──(admin retry)──→ transferindo
 *                                   falhou ──(admin cancel)──→ cancelado
 *
 * `cancelado` is terminal and is the ONLY claim-release path in the
 * system: a permanent failure (e.g. a typo'd chave pix) would otherwise
 * hold the linked funds hostage forever via the id_repasse claim. The
 * cancel action clears id_repasse on the linked lancamentos (returning
 * them to the disponivel bucket — deriveLiberacao keys on id_repasse IS
 * NULL, so zero extrato changes) inside a FOR UPDATE transaction, and is
 * audited with the acting admin. A cancelled repasse can never be retried.
 *
 * DESIGN DECISIONS (banked on aperture-vvh2j):
 *  - The new states FOLD INTO the existing `status` column — a repasse
 *    has ONE lifecycle, so one status machine. No parallel
 *    `transfer_status` column (that would invite drift).
 *  - `transfer_referencia` is nullable at the DB level (legacy rows +
 *    the manual `conta` path never set it) but is generated exactly
 *    ONCE at approval for pix repasses and reused across every attempt.
 *    Its stability is the idempotency anchor (spec §6.2).
 *  - The `repasses_um_solicitado_por_campanha` partial unique index is
 *    left UNCHANGED. It is NOT the double-pay guard — the funds-claim
 *    lock (lancamentos.id_repasse, enforced status-agnostically in
 *    solicitarRepasseTransaction's eligibility filter) is. Widening it
 *    adds zero safety and would create a retry-vs-new-solicitar unique
 *    violation. See bead for the full rationale.
 *  - `repasse_transfer_attempts` is APPEND-ONLY. The intent row is
 *    inserted and committed BEFORE the pagarPix HTTP call, so a crash
 *    mid-call leaves an orphan intent row — the signal that a payment
 *    MAY exist and must be reconciled (spec §4.2 / §6.3).
 */

const STATUS_TODOS = [
  'solicitado',
  'aprovado',
  'transferindo',
  'verificando',
  'pago',
  'falhou',
  'cancelado',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ───── repasses_recebedor: extend the status CHECK to the full FSM ─────
  await sql`
    ALTER TABLE repasses_recebedor
      DROP CONSTRAINT repasses_recebedor_status_check
  `.execute(db);

  await sql`
    ALTER TABLE repasses_recebedor
      ADD CONSTRAINT repasses_recebedor_status_check
      CHECK (status IN ('solicitado', 'aprovado', 'transferindo', 'verificando', 'pago', 'falhou', 'cancelado'))
  `.execute(db);

  // ───── repasses_recebedor: transfer bookkeeping columns ─────
  await db.schema
    .alterTable('repasses_recebedor')
    // Stable reference derived from the repasse id, generated once at
    // approval, reused across all attempts. NULL for legacy/conta rows.
    .addColumn('transfer_referencia', 'text')
    // Inter's payment id (codigoSolicitacao), set as soon as known.
    .addColumn('inter_codigo_solicitacao', 'text')
    // Monotonic attempt counter, incremented on each executar pickup.
    .addColumn('transfer_attempts', 'integer', (col) => col.notNull().defaultTo(0))
    // Operator-facing error detail. Inter error codes + codigoSolicitacao
    // only — NEVER PII (no chave, CPF, or recipient name). Enforced in code.
    .addColumn('last_transfer_error', 'text')
    .execute();

  // ───── repasse_transfer_attempts: append-only audit trail ─────
  await db.schema
    .createTable('repasse_transfer_attempts')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('repasse_id', 'uuid', (col) => col.notNull())
    .addColumn('attempt_no', 'integer', (col) => col.notNull())
    .addColumn('referencia', 'text', (col) => col.notNull())
    .addColumn('started_at', 'timestamptz', (col) => col.notNull())
    // Non-PII summary of the request (e.g. valor + masked chave type). No raw chave/CPF/name.
    .addColumn('request_summary', 'text')
    // Terminal outcome written to the attempt row by the FSM handlers:
    // pago | verificando | falhou | transitorio | cancelado. (NULL while the
    // intent row is still open, before finalizarTentativa closes it.)
    .addColumn('outcome', 'text')
    .addColumn('codigo_solicitacao', 'text')
    // Error detail — Inter code only, no PII.
    .addColumn('error', 'text')
    .addColumn('finished_at', 'timestamptz')
    .addForeignKeyConstraint(
      'repasse_transfer_attempts_repasse_id_fk',
      ['repasse_id'],
      'repasses_recebedor',
      ['id'],
    )
    // One attempt row per (repasse, attempt_no) — idempotency guard on
    // the intent-row insert so a retried job can't double-insert.
    .addUniqueConstraint('repasse_transfer_attempts_repasse_attempt_uniq', [
      'repasse_id',
      'attempt_no',
    ])
    .execute();

  await db.schema
    .createIndex('repasse_transfer_attempts_repasse_id_idx')
    .on('repasse_transfer_attempts')
    .column('repasse_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('repasse_transfer_attempts').execute();

  await db.schema
    .alterTable('repasses_recebedor')
    .dropColumn('transfer_referencia')
    .dropColumn('inter_codigo_solicitacao')
    .dropColumn('transfer_attempts')
    .dropColumn('last_transfer_error')
    .execute();

  // Restore the original two-state CHECK. Any row already advanced past
  // 'aprovado' would violate it — acceptable for a dev/staging rollback.
  await sql`
    ALTER TABLE repasses_recebedor
      DROP CONSTRAINT repasses_recebedor_status_check
  `.execute(db);

  await sql`
    ALTER TABLE repasses_recebedor
      ADD CONSTRAINT repasses_recebedor_status_check
      CHECK (status IN ('solicitado', 'aprovado'))
  `.execute(db);
}

// Exported for reuse by the domain FSM enum + tests (single source of truth).
export const REPASSE_STATUS_VALUES = STATUS_TODOS;
