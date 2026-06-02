import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Add `intencao_payment_intent_external_ref` + `intencao_charge_external_ref`
 * columns to `pagamentos`, plus partial indexes on each
 * (aperture-wif8s).
 *
 * Background: today only `checkout.session.completed` webhook events
 * link to a Pagamento (via the existing `intencao_external_ref` =
 * Stripe `cs_xxx`). Subsequent `payment_intent.*` and `charge.*`
 * events carry `pi_xxx` / `ch_xxx` references that the resolver can't
 * map back, so they archive as orphans (operator-surfaced bug 3zxkn
 * — admin UI showed only 1 of 5 events for a single cartao pagamento).
 *
 * These two new columns let the handler:
 *   - populate `intencao_payment_intent_external_ref` when
 *     `checkout.session.completed` arrives (payload carries
 *     `data.object.payment_intent`)
 *   - populate `intencao_charge_external_ref` when
 *     `payment_intent.succeeded` arrives (payload carries
 *     `data.object.latest_charge`)
 *   - look up the Pagamento for subsequent `payment_intent.*` /
 *     `charge.*` events via the new
 *     `PagamentoRepository.findByPaymentIntentExternalRef` +
 *     `findByChargeExternalRef` ports
 *
 * Both columns are nullable — pre-bead rows stay NULL until the
 * backfill (separate script, idempotent) runs. New rows start NULL
 * at intent-creation time; the webhook handler sets them as the
 * lifecycle advances.
 *
 * Partial indexes: both filter `WHERE … IS NOT NULL` because (a)
 * the lookup queries always carry a non-null value (we never search
 * "find pagamentos with NULL pi"), and (b) the bulk of the table
 * pre-backfill (and synchronous PIX-direct flows that never see a
 * Stripe payment_intent) carries NULL — keeping the index tight to
 * the rows that participate in the lookup keeps it small as data
 * grows. Same partial-index pattern as 1n6u8's
 * `payment_webhook_events_pagamento_id_idx`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ─── Phase 1 — schema ─────────────────────────────────────────────
  await sql`
    ALTER TABLE pagamentos
      ADD COLUMN intencao_payment_intent_external_ref text,
      ADD COLUMN intencao_charge_external_ref text
  `.execute(db);

  await sql`
    CREATE INDEX pagamentos_intencao_pi_ref_idx
      ON pagamentos (intencao_payment_intent_external_ref)
      WHERE intencao_payment_intent_external_ref IS NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX pagamentos_intencao_ch_ref_idx
      ON pagamentos (intencao_charge_external_ref)
      WHERE intencao_charge_external_ref IS NOT NULL
  `.execute(db);

  // ─── Phase 2 — backfill (three idempotent passes) ─────────────────
  //
  // Operates entirely against data already in payment_webhook_events
  // (1n6u8 archive). NO live Stripe API calls. Each pass's WHERE
  // clause gates on the target column being NULL, so re-running the
  // migration (or re-applying via dolt history surgery) leaves
  // populated columns untouched.
  //
  // The migration is wrapped in an implicit transaction by Kysely's
  // Migrator — all passes commit together OR roll back together.
  // Either every reachable orphan gets resolved, or nothing changes.

  // Pass 1: populate intencao_payment_intent_external_ref from
  // checkout.session.completed events. Extract payment_intent from
  // raw_payload.data.object. Skip rows where the column is already set
  // (idempotent re-runs preserve any operator hand-fix).
  await sql`
    UPDATE pagamentos p
      SET intencao_payment_intent_external_ref =
        (e.raw_payload -> 'data' -> 'object' ->> 'payment_intent')
      FROM payment_webhook_events e
      WHERE e.pagamento_id = p.id
        AND e.event_type = 'checkout.session.completed'
        AND e.raw_payload -> 'data' -> 'object' ->> 'payment_intent' IS NOT NULL
        AND p.intencao_payment_intent_external_ref IS NULL
  `.execute(db);

  // Pass 2: populate intencao_charge_external_ref from
  // payment_intent.succeeded events. latest_charge can be null until
  // Stripe creates the underlying charge; skip those.
  await sql`
    UPDATE pagamentos p
      SET intencao_charge_external_ref =
        (e.raw_payload -> 'data' -> 'object' ->> 'latest_charge')
      FROM payment_webhook_events e
      WHERE e.pagamento_id = p.id
        AND e.event_type = 'payment_intent.succeeded'
        AND e.raw_payload -> 'data' -> 'object' ->> 'latest_charge' IS NOT NULL
        AND p.intencao_charge_external_ref IS NULL
  `.execute(db);

  // Pass 3: re-link orphan webhook events (pagamento_id IS NULL) via
  // the freshly-populated columns. Three sub-passes per shape:
  //
  //   3a: payment_intent.* events → resolve via the pi (data.object.id)
  //       matched against intencao_payment_intent_external_ref.
  await sql`
    UPDATE payment_webhook_events e
      SET pagamento_id = p.id
      FROM pagamentos p
      WHERE e.pagamento_id IS NULL
        AND e.event_type LIKE 'payment_intent.%'
        AND p.intencao_payment_intent_external_ref =
          (e.raw_payload -> 'data' -> 'object' ->> 'id')
  `.execute(db);

  //   3b: charge.* events → primary lookup via the parent pi
  //       (data.object.payment_intent) matched against
  //       intencao_payment_intent_external_ref.
  await sql`
    UPDATE payment_webhook_events e
      SET pagamento_id = p.id
      FROM pagamentos p
      WHERE e.pagamento_id IS NULL
        AND e.event_type LIKE 'charge.%'
        AND p.intencao_payment_intent_external_ref =
          (e.raw_payload -> 'data' -> 'object' ->> 'payment_intent')
  `.execute(db);

  //   3c: charge.* events still orphan → fallback via the ch
  //       (data.object.id) matched against intencao_charge_external_ref.
  //       Covers re-processed charge events whose pi link is missing
  //       but whose ch matches a column populated by pass 2.
  await sql`
    UPDATE payment_webhook_events e
      SET pagamento_id = p.id
      FROM pagamentos p
      WHERE e.pagamento_id IS NULL
        AND e.event_type LIKE 'charge.%'
        AND p.intencao_charge_external_ref =
          (e.raw_payload -> 'data' -> 'object' ->> 'id')
  `.execute(db);

  // Events whose raw_payload doesn't yield a resolvable ref (truly
  // orphan: malformed events, events from another integration sharing
  // the Stripe account, signature_invalid events) stay with
  // pagamento_id NULL — surfacing them is the future orphan-browser's
  // job. NOT in this bead per the parent epic.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS pagamentos_intencao_ch_ref_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS pagamentos_intencao_pi_ref_idx`.execute(db);
  await sql`
    ALTER TABLE pagamentos
      DROP COLUMN intencao_charge_external_ref,
      DROP COLUMN intencao_payment_intent_external_ref
  `.execute(db);
}
