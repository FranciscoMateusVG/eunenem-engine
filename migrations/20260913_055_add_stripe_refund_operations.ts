import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Durable Stripe refund admission, provider evidence and local convergence.
 *
 * The mutable operation row is the recovery cursor. Facts are append-only and
 * retain every provider attempt/result across definite-refusal retries.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE stripe_refund_operations (
      operation_id uuid PRIMARY KEY,
      payment_id uuid NOT NULL UNIQUE REFERENCES pagamentos(id) ON DELETE RESTRICT,
      origin text NOT NULL CHECK (origin IN ('admin', 'webhook')),
      provider text NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
      amount_cents bigint NOT NULL CHECK (amount_cents > 0),
      currency char(3) NOT NULL CHECK (currency = 'brl'),
      charge_ref varchar(255),
      payment_intent_ref varchar(255),
      reason text NOT NULL CHECK (reason IN ('duplicate', 'fraudulent', 'requested_by_customer')),
      state text NOT NULL CHECK (state IN (
        'reserved', 'provider_started', 'provider_pending', 'provider_succeeded',
        'outcome_unknown', 'provider_failed', 'local_committed'
      )),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      provider_ref varchar(255),
      provider_status varchar(120) CHECK (
        provider_status IS NULL OR provider_status IN
          ('pending', 'succeeded', 'failed', 'canceled', 'unknown')
      ),
      provider_started_at timestamptz,
      provider_result_at timestamptz,
      local_committed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT stripe_refund_operations_provider_binding
        CHECK (charge_ref IS NOT NULL OR payment_intent_ref IS NOT NULL),
      CONSTRAINT stripe_refund_operations_local_fact
        CHECK (local_committed_at IS NULL OR state = 'local_committed'),
      CONSTRAINT stripe_refund_operations_state_shape CHECK (
        (state = 'reserved' AND attempt_count = 0
          AND provider_started_at IS NULL AND provider_result_at IS NULL
          AND provider_ref IS NULL AND provider_status IS NULL
          AND local_committed_at IS NULL)
        OR
        (state = 'provider_started' AND attempt_count > 0
          AND provider_started_at IS NOT NULL AND provider_result_at IS NULL
          AND provider_ref IS NULL AND provider_status IS NULL
          AND local_committed_at IS NULL)
        OR
        (state = 'provider_pending' AND attempt_count > 0
          AND provider_started_at IS NOT NULL AND provider_result_at IS NOT NULL
          AND provider_ref IS NOT NULL AND provider_status = 'pending'
          AND local_committed_at IS NULL)
        OR
        (state = 'provider_succeeded' AND provider_result_at IS NOT NULL
          AND provider_status = 'succeeded' AND local_committed_at IS NULL)
        OR
        (state = 'provider_failed' AND attempt_count > 0
          AND provider_started_at IS NOT NULL AND provider_result_at IS NOT NULL
          AND provider_ref IS NOT NULL AND provider_status IN ('failed', 'canceled')
          AND local_committed_at IS NULL)
        OR
        (state = 'outcome_unknown' AND provider_result_at IS NOT NULL
          AND provider_ref IS NULL AND provider_status IN ('unknown', 'succeeded')
          AND local_committed_at IS NULL)
        OR
        (state = 'local_committed' AND provider_result_at IS NOT NULL
          AND provider_status = 'succeeded' AND local_committed_at IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX stripe_refund_operations_provider_ref_uniq
      ON stripe_refund_operations(provider_ref) WHERE provider_ref IS NOT NULL;
    CREATE INDEX stripe_refund_operations_recovery_idx
      ON stripe_refund_operations(state, updated_at)
      WHERE state NOT IN ('provider_failed', 'local_committed');

    CREATE TABLE stripe_refund_operation_facts (
      id uuid PRIMARY KEY,
      operation_id uuid NOT NULL REFERENCES stripe_refund_operations(operation_id)
        ON DELETE RESTRICT,
      attempt_no integer NOT NULL CHECK (attempt_no >= 0),
      fact_kind text NOT NULL CHECK (fact_kind IN (
        'provider_started', 'provider_result', 'provider_observed',
        'provider_observed_conflict', 'local_committed'
      )),
      idempotency_key varchar(255),
      outcome text CHECK (outcome IN (
        'provider_pending', 'provider_succeeded', 'outcome_unknown', 'provider_failed'
      )),
      provider_ref varchar(255),
      provider_status varchar(120),
      provider_event_id varchar(255),
      recorded_at timestamptz NOT NULL,
      CONSTRAINT stripe_refund_operation_fact_shape CHECK (
        (fact_kind = 'provider_started'
          AND attempt_no > 0 AND idempotency_key IS NOT NULL AND outcome IS NULL
          AND provider_ref IS NULL AND provider_status IS NULL AND provider_event_id IS NULL)
        OR
        (fact_kind = 'provider_result'
          AND attempt_no > 0 AND idempotency_key IS NULL AND outcome IS NOT NULL
          AND provider_status IS NOT NULL AND provider_event_id IS NULL
          AND (
            (outcome = 'provider_pending' AND provider_ref IS NOT NULL
              AND provider_status = 'pending')
            OR (outcome = 'provider_succeeded' AND provider_ref IS NOT NULL
              AND provider_status = 'succeeded')
            OR (outcome = 'provider_failed' AND provider_ref IS NOT NULL
              AND provider_status IN ('failed', 'canceled'))
            OR (outcome = 'outcome_unknown' AND provider_ref IS NULL
              AND provider_status = 'unknown')
          ))
        OR
        (fact_kind IN ('provider_observed', 'provider_observed_conflict')
          AND idempotency_key IS NULL AND outcome IS NOT NULL
          AND provider_ref IS NULL AND provider_status = 'succeeded'
          AND provider_event_id IS NOT NULL
          AND (
            (fact_kind = 'provider_observed' AND outcome = 'provider_succeeded')
            OR (fact_kind = 'provider_observed_conflict' AND outcome = 'outcome_unknown')
          ))
        OR
        (fact_kind = 'local_committed'
          AND idempotency_key IS NULL AND outcome IS NULL
          AND provider_ref IS NULL AND provider_status IS NULL
          AND provider_event_id IS NULL)
      )
    );

    CREATE UNIQUE INDEX stripe_refund_operation_facts_idempotency_uniq
      ON stripe_refund_operation_facts(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX stripe_refund_operation_facts_attempt_kind_uniq
      ON stripe_refund_operation_facts(operation_id, attempt_no, fact_kind)
      WHERE fact_kind IN ('provider_started', 'provider_result');
    CREATE UNIQUE INDEX stripe_refund_operation_facts_local_commit_uniq
      ON stripe_refund_operation_facts(operation_id, fact_kind)
      WHERE fact_kind = 'local_committed';
    CREATE UNIQUE INDEX stripe_refund_operation_facts_provider_event_uniq
      ON stripe_refund_operation_facts(provider_event_id) WHERE provider_event_id IS NOT NULL;
    CREATE INDEX stripe_refund_operation_facts_operation_idx
      ON stripe_refund_operation_facts(operation_id, attempt_no, recorded_at);

    CREATE FUNCTION reject_stripe_refund_fact_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      RAISE EXCEPTION 'stripe refund facts are append-only';
    END
    $body$;

    CREATE TRIGGER stripe_refund_facts_append_only
      BEFORE UPDATE OR DELETE ON stripe_refund_operation_facts
      FOR EACH ROW EXECUTE FUNCTION reject_stripe_refund_fact_mutation();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Empty-only rollback. Financial evidence is never destroyed to satisfy a
  // code rollback; an operator must use a forward migration instead.
  await sql`LOCK TABLE stripe_refund_operation_facts IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`LOCK TABLE stripe_refund_operations IN ACCESS EXCLUSIVE MODE`.execute(db);
  const evidence = await sql<{ blocked: boolean }>`
    SELECT EXISTS (SELECT 1 FROM stripe_refund_operation_facts)
        OR EXISTS (SELECT 1 FROM stripe_refund_operations) AS blocked
  `.execute(db);
  if (evidence.rows[0]?.blocked === true) {
    throw new Error('Cannot roll back Stripe refund durability while financial evidence exists');
  }
  await sql`
    DROP TRIGGER stripe_refund_facts_append_only ON stripe_refund_operation_facts;
    DROP FUNCTION reject_stripe_refund_fact_mutation();
    DROP TABLE stripe_refund_operation_facts;
    DROP TABLE stripe_refund_operations;
  `.execute(db);
}
