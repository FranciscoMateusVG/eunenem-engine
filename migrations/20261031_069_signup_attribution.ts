import { type Kysely, sql } from 'kysely';

// Additive, no backfill: existing users remain unattributed.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE usuarios
    ADD COLUMN signup_utm_source text,
    ADD COLUMN signup_utm_medium text,
    ADD COLUMN signup_utm_campaign text,
    ADD COLUMN signup_utm_term text,
    ADD COLUMN signup_utm_content text,
    ADD COLUMN signup_gclid text,
    ADD COLUMN signup_gbraid text,
    ADD COLUMN signup_wbraid text,
    ADD COLUMN signup_referrer text,
    ADD COLUMN signup_landing_path text,
    ADD COLUMN signup_captured_at timestamptz`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE usuarios
    DROP COLUMN signup_utm_source,
    DROP COLUMN signup_utm_medium,
    DROP COLUMN signup_utm_campaign,
    DROP COLUMN signup_utm_term,
    DROP COLUMN signup_utm_content,
    DROP COLUMN signup_gclid,
    DROP COLUMN signup_gbraid,
    DROP COLUMN signup_wbraid,
    DROP COLUMN signup_referrer,
    DROP COLUMN signup_landing_path,
    DROP COLUMN signup_captured_at`.execute(db);
}
