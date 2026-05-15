import { z } from 'zod/v4';
import { MoneyCentsSchema } from './money.js';

export const FinancialEntryIdSchema = z.uuid();
export type FinancialEntryId = z.infer<typeof FinancialEntryIdSchema>;

export const FinancialPaymentReferenceIdSchema = z.uuid();
export type FinancialPaymentReferenceId = z.infer<typeof FinancialPaymentReferenceIdSchema>;

export const FinancialContributionReferenceIdSchema = z.uuid();
export type FinancialContributionReferenceId = z.infer<
  typeof FinancialContributionReferenceIdSchema
>;

export const FinancialReceiverIdSchema = z.uuid();
export type FinancialReceiverId = z.infer<typeof FinancialReceiverIdSchema>;

export const FinancialPayoutIdSchema = z.uuid();
export type FinancialPayoutId = z.infer<typeof FinancialPayoutIdSchema>;

export const FinancialBalanceCentsSchema = z.number().int().min(0);
export type FinancialBalanceCents = z.infer<typeof FinancialBalanceCentsSchema>;

export const FinancialPaymentStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type FinancialPaymentStatus = z.infer<typeof FinancialPaymentStatusSchema>;

export const FinancialFeePayerSchema = z.literal('contributor');
export type FinancialFeePayer = z.infer<typeof FinancialFeePayerSchema>;

export const FinancialValueCompositionSnapshotSchema = z.object({
  contributionAmountCents: MoneyCentsSchema,
  feeAmountCents: MoneyCentsSchema,
  totalPaidCents: MoneyCentsSchema,
  receiverAmountCents: MoneyCentsSchema,
  feePayer: FinancialFeePayerSchema,
});

export type FinancialValueCompositionSnapshot = Readonly<
  z.infer<typeof FinancialValueCompositionSnapshotSchema>
>;

export const RegisterApprovedPaymentFinancialEffectsInputSchema = z.object({
  paymentId: FinancialPaymentReferenceIdSchema,
  contributionId: FinancialContributionReferenceIdSchema,
  receiverId: FinancialReceiverIdSchema,
  paymentStatus: FinancialPaymentStatusSchema,
  valueComposition: FinancialValueCompositionSnapshotSchema,
});

export type RegisterApprovedPaymentFinancialEffectsInput = Readonly<
  z.infer<typeof RegisterApprovedPaymentFinancialEffectsInputSchema>
>;

export const FinancialEntryTypeSchema = z.enum([
  'receiver_balance_credit',
  'platform_revenue_credit',
]);
export type FinancialEntryType = z.infer<typeof FinancialEntryTypeSchema>;

export const FinancialEntryStatusSchema = z.enum(['pending', 'available']);
export type FinancialEntryStatus = z.infer<typeof FinancialEntryStatusSchema>;

export const FinancialEntrySchema = z.object({
  id: FinancialEntryIdSchema,
  paymentId: FinancialPaymentReferenceIdSchema,
  contributionId: FinancialContributionReferenceIdSchema,
  receiverId: FinancialReceiverIdSchema.optional(),
  type: FinancialEntryTypeSchema,
  amountCents: MoneyCentsSchema,
  status: FinancialEntryStatusSchema,
  createdAt: z.date(),
});

export type FinancialEntry = Readonly<z.infer<typeof FinancialEntrySchema>>;

export const ReceiverFinancialBalanceSchema = z.object({
  receiverId: FinancialReceiverIdSchema,
  pendingAmountCents: FinancialBalanceCentsSchema,
  availableAmountCents: FinancialBalanceCentsSchema,
});

export type ReceiverFinancialBalance = Readonly<z.infer<typeof ReceiverFinancialBalanceSchema>>;

export const GetReceiverFinancialBalanceInputSchema = z.object({
  receiverId: FinancialReceiverIdSchema,
});

export type GetReceiverFinancialBalanceInput = Readonly<
  z.infer<typeof GetReceiverFinancialBalanceInputSchema>
>;

export const PlatformRevenueSchema = z.object({
  totalAmountCents: FinancialBalanceCentsSchema,
});

export type PlatformRevenue = Readonly<z.infer<typeof PlatformRevenueSchema>>;

export const FinancialEntryIdsSchema = z.object({
  receiverEntryId: FinancialEntryIdSchema,
  platformRevenueEntryId: FinancialEntryIdSchema,
});

export type FinancialEntryIds = Readonly<z.infer<typeof FinancialEntryIdsSchema>>;

export const RequestReceiverPayoutInputSchema = z.object({
  payoutId: FinancialPayoutIdSchema,
  receiverId: FinancialReceiverIdSchema,
  amountCents: MoneyCentsSchema,
});

export type RequestReceiverPayoutInput = Readonly<z.infer<typeof RequestReceiverPayoutInputSchema>>;

export const PayoutStatusSchema = z.literal('requested');
export type PayoutStatus = z.infer<typeof PayoutStatusSchema>;

export const ReceiverPayoutSchema = z.object({
  id: FinancialPayoutIdSchema,
  receiverId: FinancialReceiverIdSchema,
  amountCents: MoneyCentsSchema,
  status: PayoutStatusSchema,
  requestedAt: z.date(),
});

export type ReceiverPayout = Readonly<z.infer<typeof ReceiverPayoutSchema>>;

export function assertApprovedPaymentFinancialComposition(
  input: RegisterApprovedPaymentFinancialEffectsInput,
): void {
  const parsed = RegisterApprovedPaymentFinancialEffectsInputSchema.parse(input);

  if (parsed.paymentStatus !== 'approved') {
    throw new Error('Only approved payments can generate financial entries.');
  }

  const { contributionAmountCents, feeAmountCents, receiverAmountCents, totalPaidCents } =
    parsed.valueComposition;

  if (receiverAmountCents + feeAmountCents !== totalPaidCents) {
    throw new Error('Financial value composition does not match total paid amount.');
  }

  if (receiverAmountCents !== contributionAmountCents) {
    throw new Error('Receiver amount must match contribution amount for contributor-paid fees.');
  }
}

export function createFinancialEntriesForApprovedPayment(
  input: RegisterApprovedPaymentFinancialEffectsInput,
  entryIds: FinancialEntryIds,
  createdAt: Date,
): readonly [FinancialEntry, FinancialEntry] {
  const parsedInput = RegisterApprovedPaymentFinancialEffectsInputSchema.parse(input);
  const parsedEntryIds = FinancialEntryIdsSchema.parse(entryIds);
  assertApprovedPaymentFinancialComposition(parsedInput);

  const receiverEntry = FinancialEntrySchema.parse({
    id: parsedEntryIds.receiverEntryId,
    paymentId: parsedInput.paymentId,
    contributionId: parsedInput.contributionId,
    receiverId: parsedInput.receiverId,
    type: 'receiver_balance_credit',
    amountCents: parsedInput.valueComposition.receiverAmountCents,
    status: 'pending',
    createdAt,
  });

  const platformRevenueEntry = FinancialEntrySchema.parse({
    id: parsedEntryIds.platformRevenueEntryId,
    paymentId: parsedInput.paymentId,
    contributionId: parsedInput.contributionId,
    type: 'platform_revenue_credit',
    amountCents: parsedInput.valueComposition.feeAmountCents,
    status: 'available',
    createdAt,
  });

  return [receiverEntry, platformRevenueEntry];
}

export function calculateReceiverFinancialBalance(
  receiverId: FinancialReceiverId,
  entries: readonly FinancialEntry[],
): ReceiverFinancialBalance {
  const parsedReceiverId = FinancialReceiverIdSchema.parse(receiverId);
  const receiverEntries = entries
    .map((entry) => FinancialEntrySchema.parse(entry))
    .filter(
      (entry) => entry.type === 'receiver_balance_credit' && entry.receiverId === parsedReceiverId,
    );

  const pendingAmountCents = receiverEntries
    .filter((entry) => entry.status === 'pending')
    .reduce<FinancialBalanceCents>((total, entry) => total + entry.amountCents, 0);

  const availableAmountCents = receiverEntries
    .filter((entry) => entry.status === 'available')
    .reduce<FinancialBalanceCents>((total, entry) => total + entry.amountCents, 0);

  return ReceiverFinancialBalanceSchema.parse({
    receiverId: parsedReceiverId,
    pendingAmountCents,
    availableAmountCents,
  });
}

export function calculatePlatformRevenue(entries: readonly FinancialEntry[]): PlatformRevenue {
  const totalAmountCents = entries
    .map((entry) => FinancialEntrySchema.parse(entry))
    .filter((entry) => entry.type === 'platform_revenue_credit')
    .reduce<FinancialBalanceCents>((total, entry) => total + entry.amountCents, 0);

  return PlatformRevenueSchema.parse({ totalAmountCents });
}

export function createRequestedReceiverPayout(
  input: RequestReceiverPayoutInput,
  requestedAt: Date,
): ReceiverPayout {
  const parsed = RequestReceiverPayoutInputSchema.parse(input);

  return ReceiverPayoutSchema.parse({
    id: parsed.payoutId,
    receiverId: parsed.receiverId,
    amountCents: parsed.amountCents,
    status: 'requested',
    requestedAt,
  });
}
