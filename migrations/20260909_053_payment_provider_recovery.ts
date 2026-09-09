import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Durable checkout-provider recovery and webhook processing fences.
 *
 * `payment_provider_operations` is the mutable recovery cursor. The sibling
 * facts table is deliberately append-only: a crash leaves a claim without a
 * fabricated result, while a later fence records a new attempt.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE payment_provider_operations (
      operation_id uuid PRIMARY KEY,
      -- Plataforma is intentionally a memory-backed BC; no table/FK exists.
      platform_id uuid NOT NULL,
      campaign_id uuid NOT NULL REFERENCES campanhas(id),
      payment_id uuid NOT NULL UNIQUE REFERENCES pagamentos(id) ON DELETE RESTRICT,
      provider text NOT NULL CHECK (provider IN ('inter', 'stripe')),
      method text NOT NULL CHECK (method IN ('pix', 'credit_card')),
      capability_hash char(64) NOT NULL CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
      request_hmac char(64) NOT NULL CHECK (request_hmac ~ '^[0-9a-f]{64}$'),
      request_snapshot jsonb NOT NULL,
      state text NOT NULL CHECK (state IN (
        'reserved', 'in_flight', 'provider_succeeded',
        'outcome_unknown', 'failed', 'local_committed'
      )),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      lease_token uuid,
      lease_until timestamptz,
      provider_started_at timestamptz,
      provider_succeeded_at timestamptz,
      provider_ref varchar(255),
      provider_expires_at timestamptz,
      local_committed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_provider_operations_snapshot_size
        CHECK (octet_length(request_snapshot::text) <= 8192),
      CONSTRAINT payment_provider_operations_lease_pair
        CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
      CONSTRAINT payment_provider_operations_provider_fact
        CHECK (
          (provider_succeeded_at IS NULL AND provider_ref IS NULL)
          OR (provider_succeeded_at IS NOT NULL AND provider_ref IS NOT NULL)
        ),
      CONSTRAINT payment_provider_operations_local_fact
        CHECK (
          local_committed_at IS NULL
          OR (provider_succeeded_at IS NOT NULL AND provider_ref IS NOT NULL)
        )
    );

    CREATE INDEX payment_provider_operations_payment_idx
      ON payment_provider_operations(payment_id);
    CREATE INDEX payment_provider_operations_recovery_idx
      ON payment_provider_operations(state, lease_until, updated_at)
      WHERE state <> 'local_committed' AND state <> 'failed';
    CREATE INDEX payment_provider_operations_capability_idx
      ON payment_provider_operations(capability_hash, state);

    CREATE TABLE payment_provider_operation_attempt_facts (
      id uuid PRIMARY KEY,
      operation_id uuid NOT NULL REFERENCES payment_provider_operations(operation_id)
        ON DELETE RESTRICT,
      attempt_no integer NOT NULL CHECK (attempt_no > 0),
      fact_kind text NOT NULL CHECK (fact_kind IN ('claim', 'result')),
      fence_token uuid NOT NULL,
      claim_kind text CHECK (claim_kind IN ('create', 'retrieve', 'reconcile')),
      prior_state text CHECK (prior_state IN (
        'reserved', 'in_flight', 'provider_succeeded',
        'outcome_unknown', 'failed', 'local_committed'
      )),
      outcome text CHECK (outcome IN ('provider_succeeded', 'outcome_unknown', 'failed')),
      diagnostic varchar(120),
      provider_ref varchar(255),
      recorded_at timestamptz NOT NULL,
      UNIQUE (operation_id, attempt_no, fact_kind),
      CONSTRAINT payment_provider_operation_attempt_fact_shape CHECK (
        (
          fact_kind = 'claim'
          AND claim_kind IS NOT NULL
          AND prior_state IS NOT NULL
          AND outcome IS NULL
          AND diagnostic IS NULL
          AND provider_ref IS NULL
        )
        OR (
          fact_kind = 'result'
          AND claim_kind IS NULL
          AND prior_state IS NULL
          AND outcome IS NOT NULL
        )
      )
    );

    CREATE INDEX payment_provider_operation_attempt_facts_operation_idx
      ON payment_provider_operation_attempt_facts(operation_id, attempt_no, recorded_at);

    CREATE FUNCTION reject_payment_provider_attempt_fact_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      RAISE EXCEPTION 'payment provider attempt facts are append-only';
    END
    $body$;

    CREATE TRIGGER payment_provider_attempt_facts_append_only
      BEFORE UPDATE OR DELETE ON payment_provider_operation_attempt_facts
      FOR EACH ROW EXECUTE FUNCTION reject_payment_provider_attempt_fact_mutation();

    ALTER TABLE payment_webhook_events
      ADD COLUMN processing_attempt_count integer NOT NULL DEFAULT 0
        CHECK (processing_attempt_count >= 0),
      ADD COLUMN processing_fence_token uuid,
      ADD COLUMN processing_lease_until timestamptz,
      ADD COLUMN processing_started_at timestamptz,
      ADD CONSTRAINT payment_webhook_events_processing_lease_pair
        CHECK ((processing_fence_token IS NULL) = (processing_lease_until IS NULL));

    CREATE INDEX payment_webhook_events_recovery_idx
      ON payment_webhook_events(processed_at, processing_lease_until, received_at)
      WHERE processed_at IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS payment_webhook_events_recovery_idx;
    ALTER TABLE payment_webhook_events
      DROP CONSTRAINT IF EXISTS payment_webhook_events_processing_lease_pair,
      DROP COLUMN IF EXISTS processing_started_at,
      DROP COLUMN IF EXISTS processing_lease_until,
      DROP COLUMN IF EXISTS processing_fence_token,
      DROP COLUMN IF EXISTS processing_attempt_count;

    DROP TRIGGER IF EXISTS payment_provider_attempt_facts_append_only
      ON payment_provider_operation_attempt_facts;
    DROP FUNCTION IF EXISTS reject_payment_provider_attempt_fact_mutation();
    DROP TABLE IF EXISTS payment_provider_operation_attempt_facts;
    DROP TABLE IF EXISTS payment_provider_operations;
  `.execute(db);
}
