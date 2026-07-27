import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Immutable audit trail for catalogue administration.
 *
 * Every admin mutation records one request lifecycle under a shared
 * request_id: requested, then succeeded or failed. Rows are append-only at
 * the database boundary; application code cannot rewrite history after the
 * fact.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('catalogo_admin_audit_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('request_id', 'uuid', (col) => col.notNull())
    .addColumn('actor_usuario_id', 'uuid', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('phase', 'text', (col) => col.notNull())
    .addColumn('target_type', 'text')
    .addColumn('target_id', 'text')
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('occurred_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'catalogo_admin_audit_events_phase_check',
      sql`phase IN ('requested', 'succeeded', 'failed')`,
    )
    .execute();

  // Reconstruct a complete request lifecycle cheaply and in event order.
  await db.schema
    .createIndex('catalogo_admin_audit_events_request_occurred_idx')
    .on('catalogo_admin_audit_events')
    .columns(['request_id', 'occurred_at'])
    .execute();

  // Operator/forensic lookup: "what did this admin do recently?"
  await db.schema
    .createIndex('catalogo_admin_audit_events_actor_occurred_idx')
    .on('catalogo_admin_audit_events')
    .columns(['actor_usuario_id', 'occurred_at'])
    .execute();

  await db.schema
    .createIndex('catalogo_admin_audit_events_target_occurred_idx')
    .on('catalogo_admin_audit_events')
    .columns(['target_type', 'target_id', 'occurred_at'])
    .execute();

  await db.schema
    .createIndex('catalogo_admin_audit_events_action_occurred_idx')
    .on('catalogo_admin_audit_events')
    .columns(['action', 'occurred_at'])
    .execute();

  // Time-ordered retention/export scans.
  await db.schema
    .createIndex('catalogo_admin_audit_events_occurred_at_idx')
    .on('catalogo_admin_audit_events')
    .column('occurred_at')
    .execute();

  await sql`
    CREATE FUNCTION catalogo_admin_audit_events_reject_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'catalogo_admin_audit_events is append-only'
        USING ERRCODE = '55000';
    END;
    $$
  `.execute(db);

  await sql`
    CREATE TRIGGER catalogo_admin_audit_events_immutable
    BEFORE UPDATE OR DELETE ON catalogo_admin_audit_events
    FOR EACH ROW
    EXECUTE FUNCTION catalogo_admin_audit_events_reject_mutation()
  `.execute(db);

  // TRUNCATE does not fire row-level DELETE triggers. Guard it explicitly so
  // bulk deletion cannot bypass the append-only boundary.
  await sql`
    CREATE TRIGGER catalogo_admin_audit_events_immutable_truncate
    BEFORE TRUNCATE ON catalogo_admin_audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION catalogo_admin_audit_events_reject_mutation()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS catalogo_admin_audit_events_immutable_truncate
    ON catalogo_admin_audit_events
  `.execute(db);
  await sql`
    DROP TRIGGER IF EXISTS catalogo_admin_audit_events_immutable
    ON catalogo_admin_audit_events
  `.execute(db);
  await db.schema.dropTable('catalogo_admin_audit_events').execute();
  await sql`DROP FUNCTION IF EXISTS catalogo_admin_audit_events_reject_mutation()`.execute(db);
}
