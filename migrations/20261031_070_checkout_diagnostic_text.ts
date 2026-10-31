import { type Kysely, sql } from 'kysely';

/** Preserve bounded, sanitized provider diagnostics without truncating audit facts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE payment_provider_operation_attempt_facts
    ALTER COLUMN diagnostic TYPE text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Fail rather than silently destroy diagnostics written after this migration.
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM payment_provider_operation_attempt_facts
               WHERE length(diagnostic) > 120) THEN
      RAISE EXCEPTION 'Cannot narrow diagnostic: retained facts exceed 120 characters';
    END IF;
  END $$`.execute(db);
  await sql`ALTER TABLE payment_provider_operation_attempt_facts
    ALTER COLUMN diagnostic TYPE varchar(120)`.execute(db);
}
