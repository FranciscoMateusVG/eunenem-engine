import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import type { FinancialLedgerRepository } from '../adapters/financial-ledger-repository.js';
import {
  createFinancialEntriesForApprovedPayment,
  type FinancialEntry,
  type RegisterApprovedPaymentFinancialEffectsInput,
  RegisterApprovedPaymentFinancialEffectsInputSchema,
} from '../domain/financial.js';
import { FinancialInvalidInputError } from '../errors/financial-invalid-input.error.js';
import { FinancialPaymentAlreadyRecordedError } from '../errors/financial-payment-already-recorded.error.js';
import { FinancialPaymentNotApprovedError } from '../errors/financial-payment-not-approved.error.js';
import type { Observability } from '../observability/observability.js';

export interface RegisterApprovedPaymentFinancialEffectsDeps {
  readonly financialLedgerRepository: FinancialLedgerRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Registra os efeitos financeiros de um pagamento aprovado sem conhecer o contribuinte.
 */
export async function registerApprovedPaymentFinancialEffects(
  deps: RegisterApprovedPaymentFinancialEffectsDeps,
  input: RegisterApprovedPaymentFinancialEffectsInput,
): Promise<readonly FinancialEntry[]> {
  const { financialLedgerRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('registerApprovedPaymentFinancialEffects', async (span) => {
    try {
      const parsed = RegisterApprovedPaymentFinancialEffectsInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinancialInvalidInputError(message);
      }

      const { paymentId, contributionId, receiverId, paymentStatus, valueComposition } =
        parsed.data;

      span.setAttribute('financial.payment.id', paymentId);
      span.setAttribute('financial.contribution.id', contributionId);
      span.setAttribute('financial.receiver.id', receiverId);

      if (paymentStatus !== 'approved') {
        throw new FinancialPaymentNotApprovedError(paymentId, paymentStatus);
      }

      const existingEntries = await financialLedgerRepository.findEntriesByPaymentId(paymentId);
      if (existingEntries.length > 0) {
        throw new FinancialPaymentAlreadyRecordedError(paymentId);
      }

      const now = clock();
      let entries: readonly FinancialEntry[];
      try {
        entries = createFinancialEntriesForApprovedPayment(
          parsed.data,
          {
            receiverEntryId: randomUUID(),
            platformRevenueEntryId: randomUUID(),
          },
          now,
        );
      } catch (error) {
        throw new FinancialInvalidInputError((error as Error).message);
      }

      await financialLedgerRepository.saveEntries(entries);

      logger.info('financial.effects.registered', {
        paymentId,
        contributionId,
        receiverId,
        receiverAmountCents: valueComposition.receiverAmountCents,
        platformRevenueAmountCents: valueComposition.feeAmountCents,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return entries;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
