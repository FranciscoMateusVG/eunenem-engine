import { z } from 'zod/v4';
import type { MoneyCents } from './money.js';
import { MoneyCentsSchema } from './money.js';

export const DEFAULT_FEE_PERCENTAGE_BPS = 500;

export const ContributionReferenceIdSchema = z.uuid();
export type ContributionReferenceId = z.infer<typeof ContributionReferenceIdSchema>;

export const FeePayerSchema = z.literal('contributor');
export type FeePayer = z.infer<typeof FeePayerSchema>;

export const FeePercentageBpsSchema = z.number().int().positive().max(10_000);
export type FeePercentageBps = z.infer<typeof FeePercentageBpsSchema>;

export const FeeRuleSchema = z.object({
  percentageBps: FeePercentageBpsSchema,
  feePayer: FeePayerSchema,
});

export type FeeRule = Readonly<z.infer<typeof FeeRuleSchema>>;

export const DEFAULT_FEE_RULE: FeeRule = {
  percentageBps: DEFAULT_FEE_PERCENTAGE_BPS,
  feePayer: 'contributor',
};

export const CalculateFeeCompositionInputSchema = z.object({
  contributionId: ContributionReferenceIdSchema,
  contributionAmountCents: MoneyCentsSchema,
});

export type CalculateFeeCompositionInput = z.infer<typeof CalculateFeeCompositionInputSchema>;

export interface FeeCalculation {
  readonly contributionId: ContributionReferenceId;
  readonly contributionAmountCents: MoneyCents;
  readonly feeAmountCents: MoneyCents;
  readonly feePayer: FeePayer;
}

export interface ValueComposition {
  readonly contributionId: ContributionReferenceId;
  readonly contributionAmountCents: MoneyCents;
  readonly feeAmountCents: MoneyCents;
  readonly totalPaidCents: MoneyCents;
  readonly receiverAmountCents: MoneyCents;
  readonly feePayer: FeePayer;
}

export function calculatePercentageFeeAmount(
  contributionAmountCents: MoneyCents,
  percentageBps: FeePercentageBps,
): MoneyCents {
  MoneyCentsSchema.parse(contributionAmountCents);
  FeePercentageBpsSchema.parse(percentageBps);

  return Math.ceil((contributionAmountCents * percentageBps) / 10_000);
}

export function calculateFee(rule: FeeRule, input: CalculateFeeCompositionInput): FeeCalculation {
  const parsedRule = FeeRuleSchema.parse(rule);
  const parsedInput = CalculateFeeCompositionInputSchema.parse(input);

  return {
    contributionId: parsedInput.contributionId,
    contributionAmountCents: parsedInput.contributionAmountCents,
    feeAmountCents: calculatePercentageFeeAmount(
      parsedInput.contributionAmountCents,
      parsedRule.percentageBps,
    ),
    feePayer: parsedRule.feePayer,
  };
}

export function composeValueComposition(calculation: FeeCalculation): ValueComposition {
  const parsedCalculation = {
    contributionId: ContributionReferenceIdSchema.parse(calculation.contributionId),
    contributionAmountCents: MoneyCentsSchema.parse(calculation.contributionAmountCents),
    feeAmountCents: MoneyCentsSchema.parse(calculation.feeAmountCents),
    feePayer: FeePayerSchema.parse(calculation.feePayer),
  };

  return {
    ...parsedCalculation,
    totalPaidCents: parsedCalculation.contributionAmountCents + parsedCalculation.feeAmountCents,
    receiverAmountCents: parsedCalculation.contributionAmountCents,
  };
}

export function calculateValueComposition(
  rule: FeeRule,
  input: CalculateFeeCompositionInput,
): ValueComposition {
  return composeValueComposition(calculateFee(rule, input));
}
