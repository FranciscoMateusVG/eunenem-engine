import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Phase 0 of plan 0015 — collapse the contribuição / pagamento / financeiro
 * state machines (aperture-8rxu0).
 *
 * Three coupled schema surgeries that ship together:
 *
 *   1. CONTRIBUIÇÕES become pure slot definitions
 *      ─────────────────────────────────────────
 *      DROP contribuinte_nome, contribuinte_email, status (+ its CHECK
 *      constraint).  Contribuição no longer carries visitor data nor an
 *      FSM — the "indisponivel" condition is now a derived predicate
 *      (`EXISTS pagamento WHERE id_contribuicao=X AND status='aprovado'`).
 *
 *   2. PAGAMENTOS gain contribuinte + the new 5-state FSM
 *      ────────────────────────────────────────────────
 *      ADD intencao_contribuinte_{nome,email,mensagem} columns (all NULLABLE
 *      at intent-creation; populated by the webhook at
 *      `checkout.session.completed` from Stripe's `custom_fields`
 *      payload — matches the existing aperture-wif8s pattern for the
 *      pi_xxx / ch_xxx external-ref columns).
 *
 *      No schema-level enum constraint on `status` — the column is `text`
 *      today (per migration 011 — values are validated at the
 *      application layer via StatusPagamentoSchema). The 5-state FSM
 *      (pendente|processing|aprovado|rejeitado|estornado) lands when
 *      Phase 1 expands the Zod enum; no DDL change here.
 *
 *   3. LANÇAMENTOS_FINANCEIROS lose the FSM entirely
 *      ─────────────────────────────────────────
 *      DROP status (+ CHECK), DROP matura_em (+ partial index), ADD
 *      transferido_em + cancelado_em (both NULLABLE timestamps). The
 *      implicit "state" becomes a query-time predicate over the two
 *      dates:
 *        pending     = transferido_em IS NULL  AND cancelado_em IS NULL
 *        transferred = transferido_em IS NOT NULL AND cancelado_em IS NULL
 *        cancelado   = cancelado_em IS NOT NULL
 *
 *      The matura_em-based partial index from migration 017 goes away;
 *      a new partial index on transferido_em IS NULL replaces it (covers
 *      the "what's pending to transfer for this recebedor?" query that
 *      the admin UI will run).
 *
 * Indexes added:
 *   - pagamentos_aprovado_por_contribuicao_idx — partial on (id_contribuicao)
 *     WHERE status='aprovado'.  Covers the new indisponivel predicate
 *     (used by the read-side check and the saga's early-fail gate).
 *   - lancamentos_pendentes_idx — partial on (id_pagamento)
 *     WHERE transferido_em IS NULL AND cancelado_em IS NULL.  Covers
 *     the "what's still pending for this pagamento?" query that the
 *     estorno gate uses to decide whether to allow the refund.
 *   - lancamentos_transferidos_por_pagamento_idx — partial on (id_pagamento)
 *     WHERE transferido_em IS NOT NULL.  Covers the estorno endpoint's
 *     409 check ("any already-transferred lançamentos on this
 *     pagamento? refuse the refund.").
 *
 * `repasses_recebedor` is intentionally LEFT UNTOUCHED.  Phase 4 of
 * 0015 decides whether the entity stays as an aggregate (with this
 * table) or gets demoted/deleted.  Pre-deciding here would force a
 * re-create in Phase 4 if the operator picks "keep."  A subsequent
 * migration handles the disposition cleanly.
 *
 * Backfill / data-preservation: NONE.  Operator confirmed via the
 * design review that there is no production data to preserve; staging
 * has been cleared throughout development.  The drops are pure
 * structural changes.
 *
 * Reversibility: `down()` re-creates the dropped columns + constraints
 * + indexes structurally identical to migrations 001/002/011/012/017.
 * It does NOT restore data — that's an unrecoverable loss by design
 * (we're killing the contribuinte-on-contribuicao concept; a downgrade
 * would have to be paired with a separate data-restoration step).
 * Existing rows post-up() will down() into the old shape with the
 * dropped columns recreated as NULL (where nullable) or with a
 * placeholder default (where NOT NULL was required pre-drop).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ──────────────────────────────────────────────────────────────────
  // (1) CONTRIBUIÇÕES — drop contribuinte fields + status FSM
  // ──────────────────────────────────────────────────────────────────

  // Drop the CHECK constraint first; otherwise the status column drop
  // fails because the constraint references it.
  await sql`
    ALTER TABLE contribuicoes
    DROP CONSTRAINT IF EXISTS contribuicoes_status_check
  `.execute(db);

  await db.schema
    .alterTable('contribuicoes')
    .dropColumn('status')
    .dropColumn('contribuinte_nome')
    .dropColumn('contribuinte_email')
    .execute();

  // ──────────────────────────────────────────────────────────────────
  // (2) PAGAMENTOS — add contribuinte columns + new partial index for
  //                  the indisponivel predicate
  // ──────────────────────────────────────────────────────────────────

  await db.schema
    .alterTable('pagamentos')
    .addColumn('intencao_contribuinte_nome', 'varchar(120)') // nullable
    .addColumn('intencao_contribuinte_email', 'varchar(320)') // nullable
    .addColumn('intencao_contribuinte_mensagem', 'varchar(255)') // nullable
    .execute();

  // The indisponivel predicate's hot path: EXISTS pagamento WHERE
  // id_contribuicao=$X AND status='aprovado'.  Partial index keeps it
  // small (only aprovado rows participate; rejected/estornado rows
  // never match).  Used by:
  //   - contribuicaoEstaIndisponivel use-case (Phase 2)
  //   - saga early-fail check in iniciar-pagamento-contribuicao (Phase 2)
  await sql`
    CREATE INDEX pagamentos_aprovado_por_contribuicao_idx
      ON pagamentos (intencao_id_contribuicao)
      WHERE status = 'aprovado'
  `.execute(db);

  // ──────────────────────────────────────────────────────────────────
  // (3) LANÇAMENTOS_FINANCEIROS — drop FSM, add date columns
  // ──────────────────────────────────────────────────────────────────

  // Drop the matura_em partial index from migration 017 before
  // dropping its column.
  await sql`DROP INDEX IF EXISTS lancamentos_pendentes_maturos_idx`.execute(db);

  // Drop the status CHECK constraint before dropping the column.
  await sql`
    ALTER TABLE lancamentos_financeiros
    DROP CONSTRAINT IF EXISTS lancamentos_financeiros_status_check
  `.execute(db);

  await db.schema
    .alterTable('lancamentos_financeiros')
    .dropColumn('status')
    .dropColumn('matura_em')
    .execute();

  await db.schema
    .alterTable('lancamentos_financeiros')
    .addColumn('transferido_em', 'timestamptz') // nullable
    .addColumn('cancelado_em', 'timestamptz') // nullable
    .execute();

  // Partial index for "what's still pending to transfer per pagamento"
  // — used by the estorno gate (Phase 2) AND the admin "saldo a
  // receber" read query.
  await sql`
    CREATE INDEX lancamentos_pendentes_idx
      ON lancamentos_financeiros (id_pagamento)
      WHERE transferido_em IS NULL AND cancelado_em IS NULL
  `.execute(db);

  // Partial index for "any already-transferred lançamentos on this
  // pagamento?" — the estorno endpoint's 409 check.  Partial because
  // we never search "find lançamentos with NULL transferido_em" via
  // this index (that's covered by the pendentes_idx above).
  await sql`
    CREATE INDEX lancamentos_transferidos_por_pagamento_idx
      ON lancamentos_financeiros (id_pagamento)
      WHERE transferido_em IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse order of up() — drop new indexes/columns first, then
  // re-add the old ones.

  // ──────────────────────────────────────────────────────────────────
  // (3) LANÇAMENTOS_FINANCEIROS — restore status + matura_em
  // ──────────────────────────────────────────────────────────────────

  await sql`DROP INDEX IF EXISTS lancamentos_transferidos_por_pagamento_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS lancamentos_pendentes_idx`.execute(db);

  await db.schema
    .alterTable('lancamentos_financeiros')
    .dropColumn('cancelado_em')
    .dropColumn('transferido_em')
    .execute();

  // Re-add status (NULLABLE temporarily so the backfill can populate);
  // backfill with 'pendente'; flip to NOT NULL; re-add the CHECK.
  await sql`ALTER TABLE lancamentos_financeiros ADD COLUMN status text`.execute(db);
  await sql`UPDATE lancamentos_financeiros SET status = 'pendente' WHERE status IS NULL`.execute(
    db,
  );
  await sql`ALTER TABLE lancamentos_financeiros ALTER COLUMN status SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE lancamentos_financeiros
    ADD CONSTRAINT lancamentos_financeiros_status_check
    CHECK (status IN ('pendente', 'disponivel'))
  `.execute(db);

  // Re-add matura_em (NULLABLE → backfill from criado_em → NOT NULL),
  // matching migration 017's down() shape.
  await sql`ALTER TABLE lancamentos_financeiros ADD COLUMN matura_em timestamptz`.execute(db);
  await sql`
    UPDATE lancamentos_financeiros SET matura_em = criado_em WHERE matura_em IS NULL
  `.execute(db);
  await sql`ALTER TABLE lancamentos_financeiros ALTER COLUMN matura_em SET NOT NULL`.execute(db);

  // Restore the partial index from migration 017.
  await sql`
    CREATE INDEX lancamentos_pendentes_maturos_idx
      ON lancamentos_financeiros (matura_em)
      WHERE status = 'pendente'
  `.execute(db);

  // ──────────────────────────────────────────────────────────────────
  // (2) PAGAMENTOS — drop contribuinte columns + indisponivel index
  // ──────────────────────────────────────────────────────────────────

  await sql`DROP INDEX IF EXISTS pagamentos_aprovado_por_contribuicao_idx`.execute(db);

  await db.schema
    .alterTable('pagamentos')
    .dropColumn('intencao_contribuinte_mensagem')
    .dropColumn('intencao_contribuinte_email')
    .dropColumn('intencao_contribuinte_nome')
    .execute();

  // ──────────────────────────────────────────────────────────────────
  // (1) CONTRIBUIÇÕES — re-add contribuinte + status
  // ──────────────────────────────────────────────────────────────────

  // contribuinte_nome/email re-added as NULLABLE (matches the post-002
  // shape; migration 002 made them nullable to support the
  // admin-created-disponivel state).
  await db.schema
    .alterTable('contribuicoes')
    .addColumn('contribuinte_nome', 'varchar(120)')
    .addColumn('contribuinte_email', 'varchar(320)')
    .execute();

  // Re-add status (NULLABLE → backfill 'disponivel' → NOT NULL → CHECK).
  await sql`ALTER TABLE contribuicoes ADD COLUMN status varchar(40)`.execute(db);
  await sql`UPDATE contribuicoes SET status = 'disponivel' WHERE status IS NULL`.execute(db);
  await sql`ALTER TABLE contribuicoes ALTER COLUMN status SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE contribuicoes
    ADD CONSTRAINT contribuicoes_status_check
    CHECK (status IN ('disponivel', 'indisponivel'))
  `.execute(db);
}
