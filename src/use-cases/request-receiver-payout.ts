import { SpanStatusCode } from '@opentelemetry/api';
import type { FinancialLedgerRepository } from '../adapters/financial-ledger-repository.js';
import {
  calculateReceiverFinancialBalance,
  createRequestedReceiverPayout,
  type ReceiverPayout,
  type RequestReceiverPayoutInput,
  RequestReceiverPayoutInputSchema,
} from '../domain/financial.js';
import { FinancialInsufficientAvailableBalanceError } from '../errors/financial-insufficient-available-balance.error.js';
import { FinancialInvalidInputError } from '../errors/financial-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface RequestReceiverPayoutDeps {
  readonly financialLedgerRepository: FinancialLedgerRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Cria um pedido inicial de resgate/repasse sem executar transferência bancária.
 */
export async function requestReceiverPayout(
  deps: RequestReceiverPayoutDeps,
  input: RequestReceiverPayoutInput,
): Promise<ReceiverPayout> {
  const { financialLedgerRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('requestReceiverPayout', async (span) => {
    try {
      const parsed = RequestReceiverPayoutInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinancialInvalidInputError(message);
      }

      const { payoutId, receiverId, amountCents } = parsed.data;
      span.setAttribute('financial.payout.id', payoutId);
      span.setAttribute('financial.receiver.id', receiverId);
      span.setAttribute('financial.payout.amount_cents', amountCents);

      const entries = await financialLedgerRepository.findEntriesByReceiverId(receiverId);
      const balance = calculateReceiverFinancialBalance(receiverId, entries);
      if (balance.availableAmountCents < amountCents) {
        throw new FinancialInsufficientAvailableBalanceError(
          receiverId,
          amountCents,
          balance.availableAmountCents,
        );
      }

      const payout = createRequestedReceiverPayout(parsed.data, clock());
      await financialLedgerRepository.savePayoutRequest(payout);

      logger.info('financial.payout.requested', {
        payoutId,
        receiverId,
        amountCents,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return payout;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
