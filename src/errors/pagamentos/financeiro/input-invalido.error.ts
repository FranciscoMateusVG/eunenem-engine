export class FinanceiroInputInvalidoError extends Error {
  public readonly code = 'FINANCEIRO_INPUT_INVALIDO' as const;

  constructor(public readonly reason: string) {
    super(`Input financeiro invalido: ${reason}`);
    this.name = 'FinanceiroInputInvalidoError';
  }
}
