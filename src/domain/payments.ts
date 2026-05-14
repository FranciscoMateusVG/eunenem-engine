import { z } from 'zod/v4';
import type { MoneyCents } from './money.js';
import { MoneyCentsSchema } from './money.js';

export const PaymentIdSchema = z.uuid();
export type PaymentId = z.infer<typeof PaymentIdSchema>;

export const PaymentIntentIdSchema = z.uuid();
export type PaymentIntentId = z.infer<typeof PaymentIntentIdSchema>;

export const ExternalTransactionIdSchema = z.uuid();
export type ExternalTransactionId = z.infer<typeof ExternalTransactionIdSchema>;

export const PaymentContributionReferenceIdSchema = z.uuid();
export type PaymentContributionReferenceId = z.infer<typeof PaymentContributionReferenceIdSchema>;

export const PaymentMethodSchema = z.enum(['pix', 'credit_card']);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const PaymentProviderNameSchema = z.string().trim().min(1).max(120);
export type PaymentProviderName = z.infer<typeof PaymentProviderNameSchema>;

export const PaymentStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const ExternalPaymentTransactionStatusSchema = z.enum(['approved', 'rejected']);
export type ExternalPaymentTransactionStatus = z.infer<
  typeof ExternalPaymentTransactionStatusSchema
>;

export const PaymentFeePayerSchema = z.literal('contributor');
export type PaymentFeePayer = z.infer<typeof PaymentFeePayerSchema>;

export const PaymentValueCompositionSnapshotSchema = z.object({
  contributionId: PaymentContributionReferenceIdSchema,
  contributionAmountCents: MoneyCentsSchema,
  feeAmountCents: MoneyCentsSchema,
  totalPaidCents: MoneyCentsSchema,
  receiverAmountCents: MoneyCentsSchema,
  feePayer: PaymentFeePayerSchema,
});

export type PaymentValueCompositionSnapshot = Readonly<
  z.infer<typeof PaymentValueCompositionSnapshotSchema>
>;

export const PaymentIntentSchema = z.object({
  id: PaymentIntentIdSchema,
  contributionId: PaymentContributionReferenceIdSchema,
  amountCents: MoneyCentsSchema,
  method: PaymentMethodSchema,
  valueComposition: PaymentValueCompositionSnapshotSchema,
  createdAt: z.date(),
});

export type PaymentIntent = Readonly<z.infer<typeof PaymentIntentSchema>>;

export const ExternalPaymentTransactionSchema = z.object({
  id: ExternalTransactionIdSchema,
  provider: PaymentProviderNameSchema,
  status: ExternalPaymentTransactionStatusSchema,
  amountCents: MoneyCentsSchema,
  createdAt: z.date(),
  rawStatus: z.string().trim().max(120).optional(),
});

export type ExternalPaymentTransaction = Readonly<z.infer<typeof ExternalPaymentTransactionSchema>>;

export const PaymentSchema = z.object({
  id: PaymentIdSchema,
  intent: PaymentIntentSchema,
  status: PaymentStatusSchema,
  externalTransaction: ExternalPaymentTransactionSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Payment = Readonly<z.infer<typeof PaymentSchema>>;

export const PaymentEventTypeSchema = z.enum([
  'payment.intent_created',
  'payment.approved',
  'payment.rejected',
]);
export type PaymentEventType = z.infer<typeof PaymentEventTypeSchema>;

export const PaymentEventSchema = z.object({
  id: z.uuid(),
  type: PaymentEventTypeSchema,
  paymentId: PaymentIdSchema,
  paymentIntentId: PaymentIntentIdSchema,
  contributionId: PaymentContributionReferenceIdSchema,
  amountCents: MoneyCentsSchema,
  status: PaymentStatusSchema,
  externalTransactionId: ExternalTransactionIdSchema.optional(),
  occurredAt: z.date(),
});

export type PaymentEvent = Readonly<z.infer<typeof PaymentEventSchema>>;

export const CreatePaymentIntentInputSchema = z.object({
  paymentId: PaymentIdSchema,
  paymentIntentId: PaymentIntentIdSchema,
  valueComposition: PaymentValueCompositionSnapshotSchema,
  amountToChargeCents: MoneyCentsSchema,
  method: PaymentMethodSchema,
});

export type CreatePaymentIntentInput = z.infer<typeof CreatePaymentIntentInputSchema>;

export const PaymentCommandInputSchema = z.object({
  paymentId: PaymentIdSchema,
});

export type PaymentCommandInput = z.infer<typeof PaymentCommandInputSchema>;

export interface CreatePendingPaymentInput {
  readonly paymentId: PaymentId;
  readonly paymentIntentId: PaymentIntentId;
  readonly valueComposition: PaymentValueCompositionSnapshot;
  readonly amountToChargeCents: MoneyCents;
  readonly method: PaymentMethod;
  readonly createdAt: Date;
}

export function createPendingPayment(input: CreatePendingPaymentInput): Payment {
  const parsed = CreatePaymentIntentInputSchema.extend({
    createdAt: z.date(),
  }).parse(input);

  if (parsed.amountToChargeCents !== parsed.valueComposition.totalPaidCents) {
    throw new Error('Payment amount must match value composition total paid amount.');
  }

  const payment: Payment = {
    id: parsed.paymentId,
    intent: {
      id: parsed.paymentIntentId,
      contributionId: parsed.valueComposition.contributionId,
      amountCents: parsed.amountToChargeCents,
      method: parsed.method,
      valueComposition: parsed.valueComposition,
      createdAt: parsed.createdAt,
    },
    status: 'pending',
    createdAt: parsed.createdAt,
    updatedAt: parsed.createdAt,
  };

  return PaymentSchema.parse(payment);
}

export function canApprovePayment(payment: Payment): boolean {
  return payment.status === 'pending';
}

export function canRejectPayment(payment: Payment): boolean {
  return payment.status === 'pending';
}

export function approvePendingPayment(
  payment: Payment,
  transaction: ExternalPaymentTransaction,
  updatedAt: Date,
): Payment {
  const parsedPayment = PaymentSchema.parse(payment);
  const parsedTransaction = ExternalPaymentTransactionSchema.parse(transaction);

  if (!canApprovePayment(parsedPayment)) {
    throw new Error(
      `Payment "${parsedPayment.id}" cannot be approved from status "${payment.status}".`,
    );
  }

  if (parsedTransaction.status !== 'approved') {
    throw new Error('External transaction must be approved to approve payment.');
  }

  if (parsedTransaction.amountCents !== parsedPayment.intent.amountCents) {
    throw new Error('External transaction amount must match payment amount.');
  }

  return PaymentSchema.parse({
    ...parsedPayment,
    status: 'approved',
    externalTransaction: parsedTransaction,
    updatedAt,
  });
}

export function rejectPendingPayment(
  payment: Payment,
  transaction: ExternalPaymentTransaction,
  updatedAt: Date,
): Payment {
  const parsedPayment = PaymentSchema.parse(payment);
  const parsedTransaction = ExternalPaymentTransactionSchema.parse(transaction);

  if (!canRejectPayment(parsedPayment)) {
    throw new Error(
      `Payment "${parsedPayment.id}" cannot be rejected from status "${payment.status}".`,
    );
  }

  if (parsedTransaction.status !== 'rejected') {
    throw new Error('External transaction must be rejected to reject payment.');
  }

  if (parsedTransaction.amountCents !== parsedPayment.intent.amountCents) {
    throw new Error('External transaction amount must match payment amount.');
  }

  return PaymentSchema.parse({
    ...parsedPayment,
    status: 'rejected',
    externalTransaction: parsedTransaction,
    updatedAt,
  });
}

export function createPaymentEvent(input: {
  readonly id: string;
  readonly type: PaymentEventType;
  readonly payment: Payment;
  readonly occurredAt: Date;
}): PaymentEvent {
  return PaymentEventSchema.parse({
    id: input.id,
    type: input.type,
    paymentId: input.payment.id,
    paymentIntentId: input.payment.intent.id,
    contributionId: input.payment.intent.contributionId,
    amountCents: input.payment.intent.amountCents,
    status: input.payment.status,
    externalTransactionId: input.payment.externalTransaction?.id,
    occurredAt: input.occurredAt,
  });
}
