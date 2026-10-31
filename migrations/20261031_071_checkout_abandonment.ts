import { type Kysely, sql } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE payment_provider_operations ADD COLUMN abandoned_at timestamptz,
    ADD CONSTRAINT checkout_abandoned_uncommitted CHECK (abandoned_at IS NULL OR
      (provider = 'inter' AND state = 'outcome_unknown' AND local_committed_at IS NULL
       AND provider_succeeded_at IS NULL AND provider_ref IS NULL AND lease_token IS NULL))`.execute(
    db,
  );
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE payment_provider_operations DROP CONSTRAINT checkout_abandoned_uncommitted,
    DROP COLUMN abandoned_at`.execute(db);
}
