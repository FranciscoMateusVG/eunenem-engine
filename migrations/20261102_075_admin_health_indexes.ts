import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX provider_attempt_failures_analytics_idx
    ON payment_provider_operation_attempt_facts (recorded_at, operation_id)
    WHERE fact_kind = 'result' AND outcome IN ('failed', 'outcome_unknown')`.execute(db);
  await sql`CREATE INDEX checkout_failures_analytics_idx
    ON payment_provider_operations (platform_id, updated_at)
    WHERE state IN ('failed', 'outcome_unknown')`.execute(db);
  await sql`CREATE INDEX webhook_failures_analytics_idx
    ON payment_webhook_events (ingress_platform_id, (coalesce(processing_started_at, received_at)))
    WHERE processing_error IS NOT NULL AND processed_at IS NULL`.execute(db);
  await sql`CREATE INDEX email_failures_analytics_idx
    ON lifecycle_email_deliveries (tenant_id, claimed_at)
    WHERE state IN ('failed', 'unknown')`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX email_failures_analytics_idx`.execute(db);
  await sql`DROP INDEX webhook_failures_analytics_idx`.execute(db);
  await sql`DROP INDEX checkout_failures_analytics_idx`.execute(db);
  await sql`DROP INDEX provider_attempt_failures_analytics_idx`.execute(db);
}
