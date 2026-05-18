export class TaxasInputInvalidoError extends Error {
  public readonly code = 'TAXAS_INPUT_INVALIDO' as const;

  constructor(public readonly reason: string) {
    super(`Input de taxas invalido: ${reason}`);
    this.name = 'TaxasInputInvalidoError';
  }
}
