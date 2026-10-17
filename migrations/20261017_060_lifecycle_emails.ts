import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE lifecycle_email_scan_cursors (
      type text PRIMARY KEY,
      last_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid
    );
    CREATE TABLE lifecycle_email_rollout (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      launch_at timestamptz NOT NULL
    );
    CREATE TABLE lifecycle_email_provisioned (
      user_id uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
      campaign_id uuid NOT NULL,
      expected_gift_count integer NOT NULL CHECK(expected_gift_count >= 0),
      completed_at timestamptz
    );
    CREATE TABLE lifecycle_email_first_gifts (
      campaign_id uuid PRIMARY KEY REFERENCES campanhas(id) ON DELETE CASCADE,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION lifecycle_email_first_gift() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO lifecycle_email_first_gifts(campaign_id) VALUES (NEW.campanha_id)
        ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$;
    CREATE TRIGGER lifecycle_email_first_gift AFTER INSERT ON contribuicoes
      FOR EACH ROW EXECUTE FUNCTION lifecycle_email_first_gift();
    CREATE TABLE lifecycle_email_events (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      type text NOT NULL CHECK(type IN ('welcome','list_ready','event_reminder','payment_received')),
      subject_id uuid NOT NULL,
      campaign_id uuid,
      occurred_at timestamptz NOT NULL,
      snapshot jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id, type, subject_id)
    );
    CREATE INDEX lifecycle_email_subject ON lifecycle_email_events(type,subject_id);
    CREATE TABLE lifecycle_email_deliveries (
      id uuid PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES lifecycle_email_events(id),
      tenant_id uuid NOT NULL,
      user_id uuid NOT NULL,
      type text NOT NULL CHECK(type IN ('welcome','list_ready','event_reminder','payment_received')),
      state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','unknown','suppressed')),
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz,
      sent_at timestamptz,
      reason text,
      template_version integer NOT NULL DEFAULT 1,
      email_key text,
      UNIQUE(event_id,email_key),
      UNIQUE(event_id,user_id)
    );
    CREATE INDEX lifecycle_email_due ON lifecycle_email_deliveries(next_attempt_at,id) WHERE state='pending';
    CREATE TABLE lifecycle_email_preferences (
      tenant_id uuid NOT NULL,
      user_id uuid NOT NULL,
      type text NOT NULL CHECK(type IN ('welcome','list_ready','event_reminder','payment_received')),
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(tenant_id,user_id,type)
    );
  `.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE lifecycle_email_preferences, lifecycle_email_deliveries, lifecycle_email_events,
      lifecycle_email_provisioned, lifecycle_email_rollout, lifecycle_email_scan_cursors;
    DROP TRIGGER lifecycle_email_first_gift ON contribuicoes;
    DROP FUNCTION lifecycle_email_first_gift();
    DROP TABLE lifecycle_email_first_gifts;
  `.execute(db);
}
