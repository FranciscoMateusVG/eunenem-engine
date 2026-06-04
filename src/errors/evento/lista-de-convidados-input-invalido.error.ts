export class ListaDeConvidadosInputInvalidoError extends Error {
  public readonly code = 'LISTA_DE_CONVIDADOS_INPUT_INVALIDO' as const;

  constructor(public readonly reason: string) {
    super(`Input de lista de convidados invalido: ${reason}`);
    this.name = 'ListaDeConvidadosInputInvalidoError';
  }
}
