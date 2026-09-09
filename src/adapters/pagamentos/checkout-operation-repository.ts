import { z } from 'zod/v4';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';

const HexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const UuidSchema = z.string().uuid();
const MoneySchema = z.number().int().nonnegative();

const SnapshotLineSchema = z
  .object({
    paymentItemId: UuidSchema,
    contributionId: UuidSchema.nullable(),
    optionId: UuidSchema.nullable(),
    optionType: z.string().min(1).max(60).nullable(),
    quantity: z.number().int().positive(),
    contributionCents: MoneySchema,
    feeCents: MoneySchema,
    receiverCents: MoneySchema,
    surchargeCents: MoneySchema,
  })
  .strict();

const SnapshotCommonSchema = z.object({
  operationId: UuidSchema,
  platformId: UuidSchema,
  campaignId: UuidSchema,
  paymentId: UuidSchema,
  intentId: UuidSchema,
  method: z.enum(['pix', 'credit_card']),
  items: z.array(SnapshotLineSchema).min(1).max(51),
  totalChargedCents: MoneySchema,
  totalReceiverCents: MoneySchema,
  totalSurchargeCents: MoneySchema,
});

export const CheckoutOperationSnapshotSchema = z.discriminatedUnion('provider', [
  SnapshotCommonSchema.extend({
    provider: z.literal('stripe'),
    idempotencyKey: z.string().min(1).max(255),
    anchorContributionId: UuidSchema,
    anchorOptionId: UuidSchema,
    anchorOptionType: z.string().min(1).max(60),
    redirectOnCompletion: z.enum(['always', 'if_required', 'never']),
  }).strict(),
  SnapshotCommonSchema.extend({
    provider: z.literal('inter'),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9]{26,35}$/),
    txid: z.string().regex(/^[A-Za-z0-9]{26,35}$/),
    expirationSeconds: z.number().int().positive().max(86_400),
  }).strict(),
]);

export type CheckoutOperationSnapshot = Readonly<z.infer<typeof CheckoutOperationSnapshotSchema>>;

export type CheckoutOperationState =
  | 'reserved'
  | 'in_flight'
  | 'provider_succeeded'
  | 'outcome_unknown'
  | 'failed'
  | 'local_committed';

export interface CheckoutOperation {
  readonly operationId: string;
  readonly platformId: string;
  readonly campaignId: string;
  readonly paymentId: string;
  readonly provider: 'inter' | 'stripe';
  readonly method: 'pix' | 'credit_card';
  readonly capabilityHash: string;
  readonly requestHmac: string;
  readonly snapshot: CheckoutOperationSnapshot;
  readonly state: CheckoutOperationState;
  readonly attemptCount: number;
  readonly leaseToken: string | null;
  readonly leaseUntil: Date | null;
  readonly providerStartedAt: Date | null;
  readonly providerSucceededAt: Date | null;
  readonly providerRef: string | null;
  readonly providerExpiresAt: Date | null;
  readonly localCommittedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PrepareCheckoutOperationInput {
  readonly pagamento: Pagamento;
  readonly operationId: string;
  readonly platformId: string;
  readonly campaignId: string;
  readonly provider: 'inter' | 'stripe';
  readonly method: 'pix' | 'credit_card';
  readonly capabilityHash: string;
  readonly requestHmac: string;
  readonly snapshot: CheckoutOperationSnapshot;
  readonly now: Date;
}

export type CheckoutClaimKind = 'create' | 'retrieve' | 'reconcile';

export type ClaimCheckoutOperationResult =
  | {
      readonly status: 'claimed';
      readonly operation: CheckoutOperation;
      readonly claimKind: CheckoutClaimKind;
      readonly attemptNo: number;
      readonly fenceToken: string;
    }
  | { readonly status: 'busy' | 'failed' | 'expired_window'; readonly operation: CheckoutOperation }
  | { readonly status: 'local_committed'; readonly operation: CheckoutOperation };

export interface ClaimCheckoutOperationInput {
  readonly operationId: string;
  readonly capabilityHash: string;
  readonly requestHmac: string;
  readonly now: Date;
  readonly leaseUntil: Date;
}

export type CheckoutAttemptOutcome = 'provider_succeeded' | 'outcome_unknown' | 'failed';

export interface CompleteCheckoutAttemptInput {
  readonly operationId: string;
  readonly attemptNo: number;
  readonly fenceToken: string;
  readonly outcome: CheckoutAttemptOutcome;
  readonly diagnostic: string | null;
  readonly providerRef: string | null;
  readonly providerExpiresAt: Date | null;
  readonly now: Date;
}

export interface CommitCheckoutLocalInput {
  readonly operationId: string;
  readonly fenceToken: string;
  readonly providerRef: string;
  readonly providerExpiresAt: Date | null;
  readonly now: Date;
}

export interface CheckoutOperationRepository {
  prepare(
    input: PrepareCheckoutOperationInput,
  ): Promise<{ readonly created: boolean; readonly operation: CheckoutOperation }>;
  findById(operationId: string): Promise<CheckoutOperation | undefined>;
  claim(input: ClaimCheckoutOperationInput): Promise<ClaimCheckoutOperationResult>;
  completeAttempt(input: CompleteCheckoutAttemptInput): Promise<boolean>;
  commitLocal(input: CommitCheckoutLocalInput): Promise<boolean>;
}

export function assertCheckoutOperationInput(input: PrepareCheckoutOperationInput): void {
  UuidSchema.parse(input.operationId);
  UuidSchema.parse(input.platformId);
  UuidSchema.parse(input.campaignId);
  HexDigestSchema.parse(input.capabilityHash);
  HexDigestSchema.parse(input.requestHmac);
  CheckoutOperationSnapshotSchema.parse(input.snapshot);
  if (
    input.pagamento.id !== input.operationId ||
    input.pagamento.id !== input.snapshot.paymentId ||
    input.platformId !== input.snapshot.platformId ||
    input.campaignId !== input.snapshot.campaignId ||
    input.provider !== input.snapshot.provider ||
    input.method !== input.snapshot.method
  ) {
    throw new Error('checkout operation/payment identity mismatch');
  }
  const serialized = JSON.stringify(input.snapshot);
  if (Buffer.byteLength(serialized, 'utf8') > 8192) {
    throw new Error('checkout operation snapshot exceeds 8192 bytes');
  }
}
