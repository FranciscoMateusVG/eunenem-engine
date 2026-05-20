export class ArrecadacaoInputInvalidoError extends Error {
  public readonly code = 'ARRECADACAO_INPUT_INVALIDO' as const;

  constructor(public readonly reason: string) {
    super(`Input de arrecadacao invalido: ${reason}`);
    this.name = 'ArrecadacaoInputInvalidoError';
  }
}
