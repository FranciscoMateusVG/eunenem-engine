import { SpanStatusCode } from '@opentelemetry/api';
import type { FeeRuleProvider } from '../adapters/fee-rule-provider.js';
import {
  type CalculateFeeCompositionInput,
  CalculateFeeCompositionInputSchema,
  calculateValueComposition,
  FeeRuleSchema,
  type ValueComposition,
} from '../domain/fees.js';
import { FeesInvalidInputError } from '../errors/fees-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface CalculateFeeCompositionDeps {
  readonly feeRuleProvider: FeeRuleProvider;
  readonly observability: Observability;
}

/**
 * Calcula a composição de valores do BC Taxas sem conhecer entidades de Arrecadação.
 */
export async function calculateFeeComposition(
  deps: CalculateFeeCompositionDeps,
  input: CalculateFeeCompositionInput,
): Promise<ValueComposition> {
  const { feeRuleProvider, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('calculateFeeComposition', async (span) => {
    try {
      const parsedInput = CalculateFeeCompositionInputSchema.safeParse(input);
      if (!parsedInput.success) {
        const message = parsedInput.error.issues.map((i) => i.message).join('; ');
        throw new FeesInvalidInputError(message);
      }

      span.setAttribute('fees.contribution.id', parsedInput.data.contributionId);
      span.setAttribute('fees.contribution.amount_cents', parsedInput.data.contributionAmountCents);

      const activeRule = await feeRuleProvider.getActiveRule();
      const parsedRule = FeeRuleSchema.safeParse(activeRule);
      if (!parsedRule.success) {
        const message = parsedRule.error.issues.map((i) => i.message).join('; ');
        throw new FeesInvalidInputError(message);
      }

      const composition = calculateValueComposition(parsedRule.data, parsedInput.data);

      logger.info('fees.composition.calculated', {
        contributionId: composition.contributionId,
        contributionAmountCents: composition.contributionAmountCents,
        feeAmountCents: composition.feeAmountCents,
        totalPaidCents: composition.totalPaidCents,
        receiverAmountCents: composition.receiverAmountCents,
        feePayer: composition.feePayer,
      });

      span.setAttribute('fees.fee.amount_cents', composition.feeAmountCents);
      span.setAttribute('fees.total_paid.amount_cents', composition.totalPaidCents);
      span.setStatus({ code: SpanStatusCode.OK });
      return composition;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
