import type { FinancialBalanceCents, FinancialReceiverId } from '../domain/financial.js';
import type { MoneyCents } from '../domain/money.js';

export class FinancialInsufficientAvailableBalanceError extends Error {
  public readonly code = 'FINANCIAL_INSUFFICIENT_AVAILABLE_BALANCE' as const;

  constructor(
    public readonly receiverId: FinancialReceiverId,
    public readonly requestedAmountCents: MoneyCents,
    public readonly availableAmountCents: FinancialBalanceCents,
  ) {
    super(
      `Receiver "${receiverId}" has ${availableAmountCents} cents available, ` +
        `but ${requestedAmountCents} cents were requested.`,
    );
    this.name = 'FinancialInsufficientAvailableBalanceError';
  }
}
