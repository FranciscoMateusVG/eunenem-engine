import { type Kysely, sql } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE provider_fee_events ADD COLUMN matching_ref text;
    CREATE TABLE provider_fee_inter_scans (
      account_ref text NOT NULL, day date NOT NULL,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      claim_token uuid, claimed_until timestamptz,
      last_success_at timestamptz, last_reason text,
      unmatched_count integer NOT NULL DEFAULT 0,
      attempts integer NOT NULL DEFAULT 0,
      PRIMARY KEY(account_ref,day)
    );`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE provider_fee_inter_scans; ALTER TABLE provider_fee_events DROP COLUMN matching_ref;`.execute(
    db,
  );
}
