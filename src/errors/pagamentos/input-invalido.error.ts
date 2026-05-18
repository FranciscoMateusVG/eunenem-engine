export class PagamentosInputInvalidoError extends Error {
  public readonly code = 'PAGAMENTOS_INPUT_INVALIDO' as const;

  constructor(public readonly reason: string) {
    super(`Input de pagamentos invalido: ${reason}`);
    this.name = 'PagamentosInputInvalidoError';
  }
}
