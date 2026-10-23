import { type Kysely, sql } from 'kysely';

/**
 * Owner alert lifecycle emails (aperture-851nu): `new_message` (a guest left a
 * recado with a gift) and `presence_confirmed` (a guest RSVP'd "sim"). Only the
 * type CHECKs widen; the outbox, dedupe keys and preferences tables are reused.
 * The scan cursor table has no CHECK and gains its `new_message` row lazily.
 */
const TABLES = [
  'lifecycle_email_preferences',
  'lifecycle_email_events',
  'lifecycle_email_deliveries',
] as const;
const PREVIOUS = sql`'welcome','list_ready','event_reminder','payment_received'`;
const WIDENED = sql`'welcome','list_ready','event_reminder','payment_received','new_message','presence_confirmed'`;

async function replaceChecks(db: Kysely<unknown>, types: typeof PREVIOUS): Promise<void> {
  for (const table of TABLES) {
    const constraint = sql.ref(`${table}_type_check`);
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT ${constraint}`.execute(db);
    await sql`ALTER TABLE ${sql.table(table)} ADD CONSTRAINT ${constraint} CHECK(type IN (${types}))`.execute(
      db,
    );
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceChecks(db, WIDENED);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Narrowing would have to delete delivery audit rows or preferences; refuse instead.
  const { rows } = await sql<{ n: string }>`SELECT (
      (SELECT count(*) FROM lifecycle_email_events WHERE type IN ('new_message','presence_confirmed'))
    + (SELECT count(*) FROM lifecycle_email_deliveries WHERE type IN ('new_message','presence_confirmed'))
    + (SELECT count(*) FROM lifecycle_email_preferences WHERE type IN ('new_message','presence_confirmed'))
    + (SELECT count(*) FROM lifecycle_email_scan_cursors WHERE type='new_message'))::text AS n`.execute(
    db,
  );
  if (Number(rows[0]?.n ?? 0) > 0)
    throw new Error(
      'Owner alert emails have rows: rollback requires manual review and preservation.',
    );
  await replaceChecks(db, PREVIOUS);
}
