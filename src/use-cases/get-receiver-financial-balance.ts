import { SpanStatusCode } from '@opentelemetry/api';
import type { FinancialLedgerRepository } from '../adapters/financial-ledger-repository.js';
import {
  calculateReceiverFinancialBalance,
  type GetReceiverFinancialBalanceInput,
  GetReceiverFinancialBalanceInputSchema,
  type ReceiverFinancialBalance,
} from '../domain/financial.js';
import { FinancialInvalidInputError } from '../errors/financial-invalid-input.error.js';
import type { Observability } from '../observability/observability.js';

export interface GetReceiverFinancialBalanceDeps {
  readonly financialLedgerRepository: FinancialLedgerRepository;
  readonly observability: Observability;
}

/**
 * Consulta o saldo financeiro do recebedor a partir dos lançamentos registrados.
 */
export async function getReceiverFinancialBalance(
  deps: GetReceiverFinancialBalanceDeps,
  input: GetReceiverFinancialBalanceInput,
): Promise<ReceiverFinancialBalance> {
  const { financialLedgerRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('getReceiverFinancialBalance', async (span) => {
    try {
      const parsed = GetReceiverFinancialBalanceInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinancialInvalidInputError(message);
      }

      span.setAttribute('financial.receiver.id', parsed.data.receiverId);

      const entries = await financialLedgerRepository.findEntriesByReceiverId(
        parsed.data.receiverId,
      );
      const balance = calculateReceiverFinancialBalance(parsed.data.receiverId, entries);

      span.setStatus({ code: SpanStatusCode.OK });
      return balance;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
