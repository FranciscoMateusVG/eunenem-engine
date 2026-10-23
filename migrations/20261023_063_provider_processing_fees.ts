import { type Kysely, sql } from 'kysely';
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE provider_fee_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL CHECK (provider IN ('stripe','inter')),
      account_ref text NOT NULL,
      environment text NOT NULL CHECK (environment IN ('test','live')),
      external_ref text NOT NULL,
      -- Financial observation is audit history: intentional RESTRICT, never silent delete.
      payment_id uuid REFERENCES pagamentos(id) ON DELETE RESTRICT,
      category text NOT NULL DEFAULT 'processing' CHECK (category = 'processing'),
      amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
      currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
      occurred_at timestamptz NOT NULL,
      observed_at timestamptz NOT NULL,
      source text NOT NULL,
      UNIQUE(provider, account_ref, environment, external_ref)
    );
    CREATE INDEX provider_fee_events_period ON provider_fee_events(occurred_at, provider);
    CREATE INDEX provider_fee_events_payment ON provider_fee_events(payment_id);
    CREATE TABLE provider_fee_sync (
      payment_id uuid PRIMARY KEY REFERENCES pagamentos(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed')),
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      claimed_until timestamptz,
      claim_token uuid,
      last_reason text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE provider_fee_sync; DROP TABLE provider_fee_events;`.execute(db);
}
