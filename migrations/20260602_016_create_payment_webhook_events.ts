import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Create the `payment_webhook_events` table (aperture-1n6u8, Finding (3)
 * of epic aperture-9erfv).
 *
 * Stripe webhooks currently fire, signature-verify, mutate domain state,
 * and the raw payload is discarded. Operator needs raw webhooks archived
 * for audit ("did we actually receive this event?"), replay (regenerate
 * state from archive), and provider-migration survival.
 *
 * Why `payment_webhook_events` and NOT `stripe_webhook_events`:
 *   adding a `provider` column with a default at table-creation time is
 *   a one-line decision; retrofitting it later when there are millions
 *   of rows is a real migration. The Stripe-specific handler still
 *   wraps the Stripe shape — provider abstraction beyond this column is
 *   out of scope per the bead.
 *
 * Why NO foreign key on `pagamento_id`:
 *   soft cross-BC link per existing engine pattern (precedent:
 *   `campanha_administradores.id_usuario`). Keeps BCs loosely coupled
 *   at the storage layer; webhook archive doesn't own Pagamento, just
 *   references it for forensic lookup.
 *
 * Write-before-verify discipline lives in the handler (not the schema):
 *   the row gets INSERTed with `signature_valid=false` BEFORE the
 *   signature is checked. Failed-signature events still get an archive
 *   row for forensic analysis. See
 *   `src/adapters/webhook-archive/stripe-webhook-pipeline.ts` for the
 *   pipeline that enforces this.
 *
 * Idempotency anchor: UNIQUE (provider, provider_event_id). Stripe
 * retries on 5xx; second arrival with same `evt_xxx` hits the unique
 * constraint and the adapter's `saveReceived` returns `isDuplicate=true`
 * so the handler can short-circuit to 200 without re-dispatching.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('payment_webhook_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('provider', 'text', (col) => col.notNull().defaultTo('stripe'))
    .addColumn('provider_event_id', 'text', (col) => col.notNull())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('raw_payload', 'jsonb', (col) => col.notNull())
    .addColumn('signature_header', 'text', (col) => col.notNull())
    .addColumn('signature_valid', 'boolean', (col) => col.notNull())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('processed_at', 'timestamptz')
    .addColumn('processing_error', 'text')
    .addColumn('pagamento_id', 'uuid')
    .execute();

  // Idempotency anchor — Stripe retries map to the same provider_event_id.
  await db.schema
    .alterTable('payment_webhook_events')
    .addUniqueConstraint('payment_webhook_events_provider_event_id_uniq', [
      'provider',
      'provider_event_id',
    ])
    .execute();

  // Forensic query: "how many failed checkout.session.completed events last week?"
  await db.schema
    .createIndex('payment_webhook_events_provider_event_type_idx')
    .on('payment_webhook_events')
    .columns(['provider', 'event_type'])
    .execute();

  // "All webhook events for pagamento X" without a JSONB scan. Partial
  // because most rows have pagamento_id NULL (events that don't resolve
  // to a known pagamento, or events processed before pagamento_id was
  // assigned).
  await sql`
    CREATE INDEX payment_webhook_events_pagamento_id_idx
      ON payment_webhook_events (pagamento_id)
      WHERE pagamento_id IS NOT NULL
  `.execute(db);

  // Recent-event browsing for the admin webhook log UI (separate bead).
  await db.schema
    .createIndex('payment_webhook_events_received_at_idx')
    .on('payment_webhook_events')
    .column('received_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('payment_webhook_events').execute();
}
