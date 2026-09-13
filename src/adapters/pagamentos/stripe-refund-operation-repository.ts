import { z } from 'zod/v4';
import type { IdPagamento } from '../../domain/pagamentos/value-objects/ids.js';

export const StripeRefundOperationStateSchema = z.enum([
  'reserved',
  'provider_started',
  'provider_pending',
  'provider_succeeded',
  'outcome_unknown',
  'provider_failed',
  'local_committed',
]);
export type StripeRefundOperationState = z.infer<typeof StripeRefundOperationStateSchema>;

export interface StripeRefundOperation {
  readonly operationId: string;
  readonly paymentId: IdPagamento;
  readonly origin: 'admin' | 'webhook';
  readonly amountCents: number;
  readonly currency: 'brl';
  readonly chargeRef: string | null;
  readonly paymentIntentRef: string | null;
  readonly reason: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  readonly state: StripeRefundOperationState;
  readonly attemptCount: number;
  readonly providerRef: string | null;
  readonly providerStatus: string | null;
  readonly providerStartedAt: Date | null;
  readonly providerResultAt: Date | null;
  readonly localCommittedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReserveStripeRefundInput {
  readonly operationId: string;
  readonly paymentId: IdPagamento;
  readonly amountCents: number;
  readonly currency: 'brl';
  readonly chargeRef: string | null;
  readonly paymentIntentRef: string | null;
  readonly reason: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  readonly now: Date;
}

export type ClaimStripeRefundResult =
  | {
      readonly status: 'call_provider';
      readonly operation: StripeRefundOperation;
      readonly attemptNo: number;
      readonly idempotencyKey: string;
    }
  | {
      readonly status:
        | 'provider_started'
        | 'provider_pending'
        | 'provider_succeeded'
        | 'outcome_unknown'
        | 'local_committed';
      readonly operation: StripeRefundOperation;
    };

export interface RecordStripeRefundResultInput {
  readonly operationId: string;
  readonly attemptNo: number;
  readonly outcome: 'provider_pending' | 'provider_succeeded' | 'provider_failed';
  readonly providerRef: string;
  readonly providerStatus: 'pending' | 'succeeded' | 'failed' | 'canceled';
  readonly amountCents: number;
  readonly currency: 'brl';
  readonly now: Date;
}

export interface ObserveVerifiedStripeRefundInput {
  readonly eventId: string;
  readonly operationId: string;
  readonly paymentId: IdPagamento;
  readonly chargeRef: string;
  readonly paymentIntentRef: string | null;
  readonly amountCents: number;
  readonly currency: string;
  readonly now: Date;
}

export interface StripeRefundOperationRepository {
  reserve(
    input: ReserveStripeRefundInput,
  ): Promise<{ readonly created: boolean; readonly operation: StripeRefundOperation }>;
  findByPaymentId(paymentId: IdPagamento): Promise<StripeRefundOperation | undefined>;
  claimProviderStart(operationId: string, now: Date): Promise<ClaimStripeRefundResult>;
  recordProviderResult(input: RecordStripeRefundResultInput): Promise<StripeRefundOperation>;
  recordOutcomeUnknown(operationId: string, attemptNo: number, now: Date): Promise<void>;
  convergeSuccessful(
    operationId: string,
    now: Date,
  ): Promise<{ readonly status: 'converged' | 'already_converged' | 'held_conflict' }>;
  observeVerifiedAndConverge(
    input: ObserveVerifiedStripeRefundInput,
  ): Promise<{ readonly status: 'converged' | 'already_converged' | 'held_conflict' }>;
}

export class StripeRefundOperationConflictError extends Error {
  constructor() {
    super('Stripe refund operation binding conflict');
    this.name = 'StripeRefundOperationConflictError';
  }
}
