export class ConviteInputInvalidoError extends Error {
  public readonly code = 'CONVITE_INPUT_INVALIDO' as const;

  constructor(public readonly reason: string) {
    super(`Input de convite invalido: ${reason}`);
    this.name = 'ConviteInputInvalidoError';
  }
}
