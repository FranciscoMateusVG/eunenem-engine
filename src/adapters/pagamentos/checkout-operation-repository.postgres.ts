import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../database.js';
import {
  assertCheckoutOperationInput,
  type CheckoutClaimKind,
  type CheckoutOperation,
  type CheckoutOperationRepository,
  CheckoutOperationSnapshotSchema,
  type ClaimCheckoutOperationInput,
  type ClaimCheckoutOperationResult,
  type CommitCheckoutLocalInput,
  type CompleteCheckoutAttemptInput,
  type PrepareCheckoutOperationInput,
} from './checkout-operation-repository.js';
import { insertItemsForPagamento, rowFromPagamento } from './repository.postgres.js';

const STRIPE_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;

interface OperationRow {
  operation_id: string;
  platform_id: string;
  campaign_id: string;
  payment_id: string;
  provider: 'inter' | 'stripe';
  method: 'pix' | 'credit_card';
  capability_hash: string;
  request_hmac: string;
  request_snapshot: unknown;
  state: CheckoutOperation['state'];
  attempt_count: number;
  lease_token: string | null;
  lease_until: Date | string | null;
  provider_started_at: Date | string | null;
  provider_succeeded_at: Date | string | null;
  provider_ref: string | null;
  provider_expires_at: Date | string | null;
  local_committed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function asDate(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function hydrate(row: OperationRow): CheckoutOperation {
  return {
    operationId: row.operation_id,
    platformId: row.platform_id,
    campaignId: row.campaign_id,
    paymentId: row.payment_id,
    provider: row.provider,
    method: row.method,
    capabilityHash: row.capability_hash,
    requestHmac: row.request_hmac,
    snapshot: CheckoutOperationSnapshotSchema.parse(row.request_snapshot),
    state: row.state,
    attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
    leaseUntil: asDate(row.lease_until),
    providerStartedAt: asDate(row.provider_started_at),
    providerSucceededAt: asDate(row.provider_succeeded_at),
    providerRef: row.provider_ref,
    providerExpiresAt: asDate(row.provider_expires_at),
    localCommittedAt: asDate(row.local_committed_at),
    createdAt: asDate(row.created_at) as Date,
    updatedAt: asDate(row.updated_at) as Date,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
  );
}

export class CheckoutOperationRepositoryPostgres implements CheckoutOperationRepository {
  constructor(private readonly db: Database) {}

  async prepare(
    input: PrepareCheckoutOperationInput,
  ): Promise<{ readonly created: boolean; readonly operation: CheckoutOperation }> {
    assertCheckoutOperationInput(input);
    try {
      const row = await this.db.transaction().execute(async (trx) => {
        const existing = await sql<OperationRow>`
          SELECT * FROM payment_provider_operations
          WHERE operation_id = ${input.operationId}::uuid
          FOR UPDATE
        `.execute(trx);
        if (existing.rows[0]) return { created: false, row: existing.rows[0] };

        await trx
          .insertInto('pagamentos')
          // biome-ignore lint/suspicious/noExplicitAny: generated Insertable brands versus validated aggregate row
          .values(rowFromPagamento(input.pagamento) as any)
          .execute();
        await insertItemsForPagamento(trx, input.pagamento);

        const inserted = await sql<OperationRow>`
          INSERT INTO payment_provider_operations
            (operation_id, platform_id, campaign_id, payment_id, provider, method,
             capability_hash, request_hmac, request_snapshot, state, created_at, updated_at)
          VALUES
            (${input.operationId}::uuid, ${input.platformId}::uuid, ${input.campaignId}::uuid,
             ${input.pagamento.id}::uuid, ${input.provider}, ${input.method},
             ${input.capabilityHash}, ${input.requestHmac},
             ${JSON.stringify(input.snapshot)}::jsonb, 'reserved', ${input.now}, ${input.now})
          RETURNING *
        `.execute(trx);
        const insertedRow = inserted.rows[0];
        if (!insertedRow) throw new Error('checkout operation insert returned no row');
        return { created: true, row: insertedRow };
      });
      return { created: row.created, operation: hydrate(row.row) };
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findById(input.operationId);
      if (!existing) throw error;
      return { created: false, operation: existing };
    }
  }

  async findById(operationId: string): Promise<CheckoutOperation | undefined> {
    const found = await sql<OperationRow>`
      SELECT * FROM payment_provider_operations
      WHERE operation_id = ${operationId}::uuid
      LIMIT 1
    `.execute(this.db);
    return found.rows[0] ? hydrate(found.rows[0]) : undefined;
  }

  async claim(input: ClaimCheckoutOperationInput): Promise<ClaimCheckoutOperationResult> {
    return this.db.transaction().execute(async (trx) => {
      const selected = await sql<OperationRow>`
        SELECT * FROM payment_provider_operations
        WHERE operation_id = ${input.operationId}::uuid
          AND capability_hash = ${input.capabilityHash}
          AND request_hmac = ${input.requestHmac}
        FOR UPDATE
      `.execute(trx);
      const row = selected.rows[0];
      if (!row) throw new Error('checkout operation authorization mismatch');
      const operation = hydrate(row);

      if (operation.state === 'local_committed') return { status: 'local_committed', operation };
      if (operation.state === 'failed') return { status: 'failed', operation };
      if (
        operation.state === 'in_flight' &&
        operation.leaseUntil !== null &&
        operation.leaseUntil.getTime() > input.now.getTime()
      ) {
        return { status: 'busy', operation };
      }

      let claimKind: CheckoutClaimKind;
      if (operation.state === 'reserved') {
        claimKind = 'create';
      } else if (operation.providerRef !== null) {
        claimKind = 'retrieve';
      } else if (operation.provider === 'inter') {
        claimKind = 'reconcile';
      } else if (
        operation.providerStartedAt !== null &&
        input.now.getTime() < operation.providerStartedAt.getTime() + STRIPE_REPLAY_WINDOW_MS
      ) {
        claimKind = 'create';
      } else {
        return { status: 'expired_window', operation };
      }

      const attemptNo = operation.attemptCount + 1;
      const fenceToken = randomUUID();
      const updated = await sql<OperationRow>`
        UPDATE payment_provider_operations
        SET state = 'in_flight', attempt_count = ${attemptNo},
            lease_token = ${fenceToken}::uuid, lease_until = ${input.leaseUntil},
            provider_started_at = coalesce(provider_started_at, ${input.now}),
            updated_at = ${input.now}
        WHERE operation_id = ${input.operationId}::uuid
        RETURNING *
      `.execute(trx);
      await sql`
        INSERT INTO payment_provider_operation_attempt_facts
          (id, operation_id, attempt_no, fact_kind, fence_token,
           claim_kind, prior_state, recorded_at)
        VALUES
          (${randomUUID()}::uuid, ${input.operationId}::uuid, ${attemptNo}, 'claim',
           ${fenceToken}::uuid, ${claimKind}, ${operation.state}, ${input.now})
      `.execute(trx);
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error('checkout claim update returned no row');
      return {
        status: 'claimed',
        operation: hydrate(updatedRow),
        claimKind,
        attemptNo,
        fenceToken,
      };
    });
  }

  async completeAttempt(input: CompleteCheckoutAttemptInput): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const selected = await sql<OperationRow>`
        SELECT * FROM payment_provider_operations
        WHERE operation_id = ${input.operationId}::uuid
          AND state = 'in_flight'
          AND attempt_count = ${input.attemptNo}
          AND lease_token = ${input.fenceToken}::uuid
        FOR UPDATE
      `.execute(trx);
      const current = selected.rows[0];
      if (!current) return false;

      if (
        input.outcome === 'provider_succeeded' &&
        (input.providerRef === null ||
          (current.provider_ref !== null && current.provider_ref !== input.providerRef))
      ) {
        throw new Error('checkout provider reference mismatch');
      }

      await sql`
        INSERT INTO payment_provider_operation_attempt_facts
          (id, operation_id, attempt_no, fact_kind, fence_token,
           outcome, diagnostic, provider_ref, recorded_at)
        VALUES
          (${randomUUID()}::uuid, ${input.operationId}::uuid, ${input.attemptNo}, 'result',
           ${input.fenceToken}::uuid, ${input.outcome}, ${input.diagnostic},
           ${input.providerRef}, ${input.now})
      `.execute(trx);

      const succeeded = input.outcome === 'provider_succeeded';
      const update = await sql`
        UPDATE payment_provider_operations
        SET state = ${input.outcome},
            provider_succeeded_at = CASE
              WHEN ${succeeded} THEN coalesce(provider_succeeded_at, ${input.now})
              ELSE provider_succeeded_at
            END,
            provider_ref = CASE
              WHEN ${succeeded} THEN coalesce(provider_ref, ${input.providerRef})
              ELSE provider_ref
            END,
            provider_expires_at = CASE
              WHEN ${succeeded} THEN coalesce(provider_expires_at, ${input.providerExpiresAt})
              ELSE provider_expires_at
            END,
            lease_token = CASE WHEN ${succeeded} THEN lease_token ELSE NULL END,
            lease_until = CASE WHEN ${succeeded} THEN lease_until ELSE NULL END,
            updated_at = ${input.now}
        WHERE operation_id = ${input.operationId}::uuid
          AND state = 'in_flight'
          AND attempt_count = ${input.attemptNo}
          AND lease_token = ${input.fenceToken}::uuid
      `.execute(trx);
      return Number(update.numAffectedRows ?? 0n) === 1;
    });
  }

  async commitLocal(input: CommitCheckoutLocalInput): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const updatedPayment = await sql`
        UPDATE pagamentos AS p
        SET intencao_external_ref = coalesce(p.intencao_external_ref, ${input.providerRef}),
            intencao_expira_em = coalesce(p.intencao_expira_em, ${input.providerExpiresAt}),
            atualizado_em = ${input.now}
        FROM payment_provider_operations AS operation
        WHERE operation.operation_id = ${input.operationId}::uuid
          AND operation.payment_id = p.id
          AND operation.state = 'provider_succeeded'
          AND operation.provider_ref = ${input.providerRef}
          AND operation.lease_token = ${input.fenceToken}::uuid
          AND (p.intencao_external_ref IS NULL OR p.intencao_external_ref = ${input.providerRef})
      `.execute(trx);
      if (Number(updatedPayment.numAffectedRows ?? 0n) !== 1) return false;

      const updatedOperation = await sql`
        UPDATE payment_provider_operations
        SET state = 'local_committed', local_committed_at = coalesce(local_committed_at, ${input.now}),
            lease_token = NULL, lease_until = NULL, updated_at = ${input.now}
        WHERE operation_id = ${input.operationId}::uuid
          AND state = 'provider_succeeded'
          AND provider_ref = ${input.providerRef}
          AND lease_token = ${input.fenceToken}::uuid
      `.execute(trx);
      if (Number(updatedOperation.numAffectedRows ?? 0n) !== 1) {
        throw new Error('checkout local commit lost its operation fence');
      }
      return true;
    });
  }
}
