import type { IdEvento, IdListaDeConvidados } from '../../domain/evento/value-objects/ids.js';

export class ListaDeConvidadosNaoEncontradaError extends Error {
  public readonly code = 'LISTA_DE_CONVIDADOS_NAO_ENCONTRADA' as const;

  constructor(
    public readonly idListaDeConvidados?: IdListaDeConvidados,
    public readonly idEvento?: IdEvento,
  ) {
    const message =
      idListaDeConvidados !== undefined
        ? `Lista de convidados nao encontrada: ${idListaDeConvidados}`
        : `Lista de convidados nao encontrada para evento: ${idEvento}`;
    super(message);
    this.name = 'ListaDeConvidadosNaoEncontradaError';
  }
}
