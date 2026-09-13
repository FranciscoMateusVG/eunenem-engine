import { randomUUID } from 'node:crypto';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Database } from '../database.js';
import type { DB } from '../db-types.generated.js';
import {
  acquirePaymentMoneyMovementLocks,
  assertRefundCreationAllowed,
} from './payment-money-movement-lock.postgres.js';
import {
  type ClaimStripeRefundResult,
  type ObserveVerifiedStripeRefundInput,
  type RecordStripeRefundResultInput,
  type ReserveStripeRefundInput,
  type StripeRefundOperation,
  StripeRefundOperationConflictError,
  type StripeRefundOperationRepository,
  StripeRefundOperationStateSchema,
} from './stripe-refund-operation-repository.js';

type Executor = Kysely<DB> | Transaction<DB>;

interface OperationRow {
  operation_id: string;
  payment_id: string;
  origin: 'admin' | 'webhook';
  amount_cents: string | number | bigint;
  currency: 'brl';
  charge_ref: string | null;
  payment_intent_ref: string | null;
  reason: StripeRefundOperation['reason'];
  state: StripeRefundOperation['state'];
  attempt_count: number;
  provider_ref: string | null;
  provider_status: string | null;
  provider_started_at: Date | string | null;
  provider_result_at: Date | string | null;
  local_committed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PaymentRow {
  id: string;
  status: string;
  intencao_total_paid_cents: string | number | bigint;
  intencao_charge_external_ref: string | null;
  intencao_payment_intent_external_ref: string | null;
  transacao_externa: unknown;
}

function date(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function hydrate(row: OperationRow): StripeRefundOperation {
  return {
    operationId: row.operation_id,
    paymentId: row.payment_id as StripeRefundOperation['paymentId'],
    origin: row.origin,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    chargeRef: row.charge_ref,
    paymentIntentRef: row.payment_intent_ref,
    reason: row.reason,
    state: StripeRefundOperationStateSchema.parse(row.state),
    attemptCount: row.attempt_count,
    providerRef: row.provider_ref,
    providerStatus: row.provider_status,
    providerStartedAt: date(row.provider_started_at),
    providerResultAt: date(row.provider_result_at),
    localCommittedAt: date(row.local_committed_at),
    createdAt: date(row.created_at) as Date,
    updatedAt: date(row.updated_at) as Date,
  };
}

function paymentBindingMatches(row: PaymentRow, input: ReserveStripeRefundInput): boolean {
  const transaction = row.transacao_externa as {
    id?: unknown;
    provedor?: unknown;
    status?: unknown;
    amountCents?: unknown;
  } | null;
  return (
    row.id === input.paymentId &&
    row.status === 'aprovado' &&
    Number(row.intencao_total_paid_cents) === input.amountCents &&
    row.intencao_charge_external_ref === input.chargeRef &&
    row.intencao_payment_intent_external_ref === input.paymentIntentRef &&
    transaction?.provedor === 'stripe' &&
    transaction.status === 'aprovado' &&
    transaction.amountCents === input.amountCents &&
    (transaction.id === input.chargeRef || transaction.id === input.paymentIntentRef)
  );
}

function verifiedPaymentBindingMatches(
  row: PaymentRow,
  input: ObserveVerifiedStripeRefundInput,
): boolean {
  const transaction = row.transacao_externa as {
    id?: unknown;
    provedor?: unknown;
    status?: unknown;
    amountCents?: unknown;
  } | null;
  return (
    (row.status === 'aprovado' || row.status === 'estornado') &&
    input.currency === 'brl' &&
    Number(row.intencao_total_paid_cents) === input.amountCents &&
    row.intencao_charge_external_ref === input.chargeRef &&
    row.intencao_payment_intent_external_ref === input.paymentIntentRef &&
    transaction?.provedor === 'stripe' &&
    transaction.status === 'aprovado' &&
    transaction.amountCents === input.amountCents &&
    (transaction.id === input.chargeRef || transaction.id === input.paymentIntentRef)
  );
}

function operationBindingMatches(
  row: OperationRow,
  input: Pick<
    ReserveStripeRefundInput,
    'paymentId' | 'amountCents' | 'currency' | 'chargeRef' | 'paymentIntentRef' | 'reason'
  >,
): boolean {
  return (
    row.payment_id === input.paymentId &&
    Number(row.amount_cents) === input.amountCents &&
    row.currency === input.currency &&
    row.charge_ref === input.chargeRef &&
    row.payment_intent_ref === input.paymentIntentRef &&
    row.reason === input.reason
  );
}

async function lockPayment(executor: Executor, paymentId: string): Promise<PaymentRow | undefined> {
  const selected = await sql<PaymentRow>`
    SELECT id, status, intencao_total_paid_cents, intencao_charge_external_ref,
           intencao_payment_intent_external_ref, transacao_externa
      FROM pagamentos WHERE id = ${paymentId}::uuid FOR UPDATE
  `.execute(executor);
  return selected.rows[0];
}

async function hasFinancialConflict(executor: Executor, paymentId: string): Promise<boolean> {
  const result = await sql<{ blocked: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM lancamentos_financeiros l
      LEFT JOIN repasses_recebedor r ON r.id = l.id_repasse
      WHERE l.id_pagamento = ${paymentId}::uuid
        AND (l.transferido_em IS NOT NULL OR r.status IN
          ('transferindo', 'verificando', 'enviado_ao_banco', 'pago'))
    ) AS blocked
  `.execute(executor);
  return result.rows[0]?.blocked === true;
}

async function findOperation(
  executor: Executor,
  operationId: string,
): Promise<OperationRow | undefined> {
  const result = await sql<OperationRow>`
    SELECT * FROM stripe_refund_operations WHERE operation_id = ${operationId}::uuid
  `.execute(executor);
  return result.rows[0];
}

async function convergeInTransaction(
  tx: Executor,
  row: OperationRow,
  now: Date,
): Promise<'converged' | 'already_converged' | 'held_conflict'> {
  if (row.state === 'local_committed') return 'already_converged';
  if (row.state !== 'provider_succeeded') return 'held_conflict';
  const payment = await lockPayment(tx, row.payment_id);
  if (!payment || (payment.status !== 'aprovado' && payment.status !== 'estornado')) {
    return 'held_conflict';
  }
  if (await hasFinancialConflict(tx, row.payment_id)) return 'held_conflict';

  const paymentUpdate = await sql`
    UPDATE pagamentos SET status = 'estornado', atualizado_em = ${now}
      WHERE id = ${row.payment_id}::uuid AND status IN ('aprovado', 'estornado')
  `.execute(tx);
  if (Number(paymentUpdate.numAffectedRows ?? 0n) !== 1) return 'held_conflict';
  await sql`
    UPDATE lancamentos_financeiros SET cancelado_em = coalesce(cancelado_em, ${now})
      WHERE id_pagamento = ${row.payment_id}::uuid
        AND transferido_em IS NULL AND cancelado_em IS NULL
  `.execute(tx);
  const operationUpdate = await sql`
    UPDATE stripe_refund_operations
      SET state = 'local_committed', local_committed_at = coalesce(local_committed_at, ${now}),
          updated_at = ${now}
      WHERE operation_id = ${row.operation_id}::uuid AND state = 'provider_succeeded'
  `.execute(tx);
  if (Number(operationUpdate.numAffectedRows ?? 0n) !== 1) {
    throw new Error('Stripe refund local convergence lost operation state');
  }
  await sql`
    INSERT INTO stripe_refund_operation_facts
      (id, operation_id, attempt_no, fact_kind, recorded_at)
    VALUES (${randomUUID()}::uuid, ${row.operation_id}::uuid,
      ${row.attempt_count}, 'local_committed', ${now})
    ON CONFLICT (operation_id, fact_kind) WHERE fact_kind = 'local_committed' DO NOTHING
  `.execute(tx);
  return payment.status === 'estornado' ? 'already_converged' : 'converged';
}

export class StripeRefundOperationRepositoryPostgres implements StripeRefundOperationRepository {
  constructor(private readonly db: Database) {}

  async reserve(input: ReserveStripeRefundInput) {
    return this.db.transaction().execute(async (tx) => {
      await acquirePaymentMoneyMovementLocks(tx, [input.paymentId]);
      const payment = await lockPayment(tx, input.paymentId);
      if (!payment || !paymentBindingMatches(payment, input)) {
        throw new StripeRefundOperationConflictError();
      }
      await assertRefundCreationAllowed(tx, input.paymentId);
      const inserted = await sql<OperationRow>`
        INSERT INTO stripe_refund_operations
          (operation_id, payment_id, origin, amount_cents, currency, charge_ref,
           payment_intent_ref, reason, state, created_at, updated_at)
        VALUES (${input.operationId}::uuid, ${input.paymentId}::uuid, 'admin',
          ${input.amountCents}, ${input.currency}, ${input.chargeRef},
          ${input.paymentIntentRef}, ${input.reason}, 'reserved', ${input.now}, ${input.now})
        ON CONFLICT (payment_id) DO NOTHING RETURNING *
      `.execute(tx);
      if (inserted.rows[0]) return { created: true, operation: hydrate(inserted.rows[0]) };
      const existing = await sql<OperationRow>`
        SELECT * FROM stripe_refund_operations WHERE payment_id = ${input.paymentId}::uuid FOR UPDATE
      `.execute(tx);
      const row = existing.rows[0];
      if (!row || !operationBindingMatches(row, input)) {
        throw new StripeRefundOperationConflictError();
      }
      return { created: false, operation: hydrate(row) };
    });
  }

  async findByPaymentId(paymentId: StripeRefundOperation['paymentId']) {
    const result = await sql<OperationRow>`
      SELECT * FROM stripe_refund_operations WHERE payment_id = ${paymentId}::uuid
    `.execute(this.db);
    return result.rows[0] ? hydrate(result.rows[0]) : undefined;
  }

  async claimProviderStart(operationId: string, now: Date): Promise<ClaimStripeRefundResult> {
    return this.db.transaction().execute(async (tx) => {
      const identity = await sql<{ payment_id: string }>`
        SELECT payment_id FROM stripe_refund_operations WHERE operation_id = ${operationId}::uuid
      `.execute(tx);
      if (!identity.rows[0]) throw new StripeRefundOperationConflictError();
      await acquirePaymentMoneyMovementLocks(tx, [identity.rows[0].payment_id]);
      const current = await sql<OperationRow>`
        SELECT * FROM stripe_refund_operations WHERE operation_id = ${operationId}::uuid FOR UPDATE
      `.execute(tx);
      const row = current.rows[0];
      if (!row) throw new StripeRefundOperationConflictError();
      if (row.state !== 'reserved' && row.state !== 'provider_failed') {
        return {
          status: row.state as Exclude<ClaimStripeRefundResult['status'], 'call_provider'>,
          operation: hydrate(row),
        };
      }
      await assertRefundCreationAllowed(tx, row.payment_id);
      const attemptNo = row.attempt_count + 1;
      const idempotencyKey = `pagamento:${row.payment_id}:refund:${attemptNo}`;
      const updated = await sql<OperationRow>`
        UPDATE stripe_refund_operations
          SET state = 'provider_started', attempt_count = ${attemptNo},
              provider_started_at = ${now}, provider_ref = NULL, provider_status = NULL,
              provider_result_at = NULL, updated_at = ${now}
          WHERE operation_id = ${operationId}::uuid
            AND state IN ('reserved', 'provider_failed')
          RETURNING *
      `.execute(tx);
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error('Stripe refund claim lost its state');
      await sql`
        INSERT INTO stripe_refund_operation_facts
          (id, operation_id, attempt_no, fact_kind, idempotency_key, recorded_at)
        VALUES (${randomUUID()}::uuid, ${operationId}::uuid, ${attemptNo},
          'provider_started', ${idempotencyKey}, ${now})
      `.execute(tx);
      return { status: 'call_provider', operation: hydrate(updatedRow), attemptNo, idempotencyKey };
    });
  }

  async recordProviderResult(input: RecordStripeRefundResultInput): Promise<StripeRefundOperation> {
    return this.db.transaction().execute(async (tx) => {
      const current = await sql<OperationRow>`
        SELECT * FROM stripe_refund_operations WHERE operation_id = ${input.operationId}::uuid FOR UPDATE
      `.execute(tx);
      const row = current.rows[0];
      if (!row) throw new StripeRefundOperationConflictError();
      if (
        row.attempt_count !== input.attemptNo ||
        Number(row.amount_cents) !== input.amountCents ||
        row.currency !== input.currency
      ) {
        throw new StripeRefundOperationConflictError();
      }
      if (row.state !== 'provider_started') return hydrate(row);
      await sql`
        INSERT INTO stripe_refund_operation_facts
          (id, operation_id, attempt_no, fact_kind, outcome, provider_ref,
           provider_status, recorded_at)
        VALUES (${randomUUID()}::uuid, ${input.operationId}::uuid, ${input.attemptNo},
          'provider_result', ${input.outcome}, ${input.providerRef},
          ${input.providerStatus}, ${input.now})
      `.execute(tx);
      const updated = await sql<OperationRow>`
        UPDATE stripe_refund_operations SET state = ${input.outcome},
          provider_ref = ${input.providerRef}, provider_status = ${input.providerStatus},
          provider_result_at = ${input.now}, updated_at = ${input.now}
        WHERE operation_id = ${input.operationId}::uuid AND state = 'provider_started'
        RETURNING *
      `.execute(tx);
      if (!updated.rows[0]) throw new Error('Stripe refund result lost its state');
      return hydrate(updated.rows[0]);
    });
  }

  async recordOutcomeUnknown(operationId: string, attemptNo: number, now: Date): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const current = await sql<OperationRow>`
        SELECT * FROM stripe_refund_operations WHERE operation_id = ${operationId}::uuid FOR UPDATE
      `.execute(tx);
      const row = current.rows[0];
      if (!row || row.attempt_count !== attemptNo || row.state !== 'provider_started') return;
      await sql`
        INSERT INTO stripe_refund_operation_facts
          (id, operation_id, attempt_no, fact_kind, outcome, provider_status, recorded_at)
        VALUES (${randomUUID()}::uuid, ${operationId}::uuid, ${attemptNo},
          'provider_result', 'outcome_unknown', 'unknown', ${now})
      `.execute(tx);
      await sql`
        UPDATE stripe_refund_operations SET state = 'outcome_unknown',
          provider_status = 'unknown', provider_result_at = ${now}, updated_at = ${now}
        WHERE operation_id = ${operationId}::uuid AND state = 'provider_started'
      `.execute(tx);
    });
  }

  async convergeSuccessful(operationId: string, now: Date) {
    return this.db.transaction().execute(async (tx) => {
      const identity = await sql<{ payment_id: string }>`
        SELECT payment_id FROM stripe_refund_operations WHERE operation_id = ${operationId}::uuid
      `.execute(tx);
      if (!identity.rows[0]) throw new StripeRefundOperationConflictError();
      await acquirePaymentMoneyMovementLocks(tx, [identity.rows[0].payment_id]);
      const current = await sql<OperationRow>`
        SELECT * FROM stripe_refund_operations WHERE operation_id = ${operationId}::uuid FOR UPDATE
      `.execute(tx);
      const row = current.rows[0];
      if (!row) throw new StripeRefundOperationConflictError();
      return { status: await convergeInTransaction(tx, row, now) };
    });
  }

  async observeVerifiedAndConverge(input: ObserveVerifiedStripeRefundInput) {
    return this.db.transaction().execute(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction keeps provider observation, conflict evidence and local convergence atomic
      async (tx) => {
        await acquirePaymentMoneyMovementLocks(tx, [input.paymentId]);
        const priorEvent = await sql<{ operation_id: string }>`
        SELECT operation_id FROM stripe_refund_operation_facts
          WHERE provider_event_id = ${input.eventId}
      `.execute(tx);
        if (priorEvent.rows[0]) {
          const replay = await findOperation(tx, priorEvent.rows[0].operation_id);
          if (!replay) throw new Error('Stripe refund event lost its operation');
          return {
            status: replay.state === 'local_committed' ? 'already_converged' : 'held_conflict',
          } as const;
        }

        const payment = await lockPayment(tx, input.paymentId);
        if (!payment) throw new StripeRefundOperationConflictError();
        const existingResult = await sql<OperationRow>`
        SELECT * FROM stripe_refund_operations WHERE payment_id = ${input.paymentId}::uuid FOR UPDATE
      `.execute(tx);
        let row = existingResult.rows[0];
        const paymentExact = verifiedPaymentBindingMatches(payment, input);
        const operationExact =
          row === undefined ||
          (row.payment_id === input.paymentId &&
            Number(row.amount_cents) === input.amountCents &&
            row.currency === input.currency &&
            row.charge_ref === input.chargeRef &&
            row.payment_intent_ref === input.paymentIntentRef);
        const conflict =
          !paymentExact || !operationExact || (await hasFinancialConflict(tx, input.paymentId));

        if (!row) {
          const inserted = await sql<OperationRow>`
          INSERT INTO stripe_refund_operations
            (operation_id, payment_id, origin, amount_cents, currency, charge_ref,
             payment_intent_ref, reason, state, provider_status, provider_result_at,
             created_at, updated_at)
          VALUES (${input.operationId}::uuid, ${input.paymentId}::uuid, 'webhook',
            ${input.amountCents}, 'brl', ${input.chargeRef},
            ${input.paymentIntentRef}, 'requested_by_customer',
            ${conflict ? 'outcome_unknown' : 'provider_succeeded'},
            'succeeded', ${input.now}, ${input.now}, ${input.now})
          RETURNING *
        `.execute(tx);
          row = inserted.rows[0];
          if (!row) throw new Error('Stripe refund webhook insert returned no row');
        } else if (conflict && row.state !== 'local_committed') {
          const updated = await sql<OperationRow>`
            UPDATE stripe_refund_operations SET state = 'outcome_unknown',
              provider_ref = NULL, provider_status = 'succeeded',
              provider_result_at = ${input.now}, updated_at = ${input.now}
              WHERE operation_id = ${row.operation_id}::uuid RETURNING *
          `.execute(tx);
          row = updated.rows[0] as OperationRow;
        } else if (!conflict && row.state !== 'local_committed') {
          const updated = await sql<OperationRow>`
            UPDATE stripe_refund_operations SET state = 'provider_succeeded',
              provider_ref = NULL, provider_status = 'succeeded',
              provider_result_at = ${input.now},
              updated_at = ${input.now}
            WHERE operation_id = ${row.operation_id}::uuid RETURNING *
        `.execute(tx);
          row = updated.rows[0] as OperationRow;
        }

        await sql`
        INSERT INTO stripe_refund_operation_facts
          (id, operation_id, attempt_no, fact_kind, outcome, provider_status,
           provider_event_id, observed_charge_ref, observed_payment_intent_ref,
           observed_amount_cents, observed_currency, recorded_at)
        VALUES (${randomUUID()}::uuid, ${row.operation_id}::uuid, ${row.attempt_count},
          ${conflict ? 'provider_observed_conflict' : 'provider_observed'},
          ${conflict ? 'outcome_unknown' : 'provider_succeeded'}, 'succeeded',
          ${input.eventId}, ${input.chargeRef}, ${input.paymentIntentRef},
          ${input.amountCents}, ${input.currency}, ${input.now})
      `.execute(tx);
        if (conflict) return { status: 'held_conflict' as const };
        return { status: await convergeInTransaction(tx, row, input.now) };
      },
    );
  }
}
