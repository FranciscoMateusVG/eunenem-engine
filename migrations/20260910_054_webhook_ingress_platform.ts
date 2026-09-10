import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Record the platform-scoped webhook ingress that first archived an event.
 *
 * The value is deliberately nullable: historical rows predate this provenance
 * fact and must not be inferred or backfilled. It proves only that the event
 * was received at a platform-dedicated endpoint. Provider/payment ownership is
 * represented separately by signature/processing/payment-link facts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE payment_webhook_events
      ADD COLUMN ingress_platform_id uuid;

    CREATE INDEX payment_webhook_events_unmatched_ingress_idx
      ON payment_webhook_events
        (ingress_platform_id, provider, received_at DESC, id DESC)
      WHERE pagamento_id IS NULL AND ingress_platform_id IS NOT NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS payment_webhook_events_unmatched_ingress_idx;
    ALTER TABLE payment_webhook_events
      DROP COLUMN IF EXISTS ingress_platform_id;
  `.execute(db);
}
