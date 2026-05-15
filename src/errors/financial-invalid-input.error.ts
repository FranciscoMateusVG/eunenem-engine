export class FinancialInvalidInputError extends Error {
  public readonly code = 'FINANCIAL_INVALID_INPUT' as const;

  constructor(public readonly reason: string) {
    super(`Invalid financial input: ${reason}`);
    this.name = 'FinancialInvalidInputError';
  }
}
