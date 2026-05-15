import type {
  FinancialEntry,
  FinancialPaymentReferenceId,
  FinancialPayoutId,
  FinancialReceiverId,
  ReceiverPayout,
} from '../domain/financial.js';

/**
 * Persistência do livro financeiro (porta).
 */
export interface FinancialLedgerRepository {
  saveEntries(entries: readonly FinancialEntry[]): Promise<void>;
  findEntriesByPaymentId(
    paymentId: FinancialPaymentReferenceId,
  ): Promise<readonly FinancialEntry[]>;
  findEntriesByReceiverId(receiverId: FinancialReceiverId): Promise<readonly FinancialEntry[]>;
  findPlatformRevenueEntries(): Promise<readonly FinancialEntry[]>;
  savePayoutRequest(payout: ReceiverPayout): Promise<void>;
  findPayoutRequestById(payoutId: FinancialPayoutId): Promise<ReceiverPayout | undefined>;
  findPayoutRequestsByReceiverId(
    receiverId: FinancialReceiverId,
  ): Promise<readonly ReceiverPayout[]>;
}
