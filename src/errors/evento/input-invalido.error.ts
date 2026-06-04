export class EventoInputInvalidoError extends Error {
  public readonly code = 'EVENTO_INPUT_INVALIDO' as const;

  constructor(public readonly reason: string) {
    super(`Input de evento invalido: ${reason}`);
    this.name = 'EventoInputInvalidoError';
  }
}
