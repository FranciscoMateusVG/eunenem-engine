import type { IdConvidado, IdListaDeConvidados } from '../../domain/evento/value-objects/ids.js';

export class ConvidadoNaoEncontradoError extends Error {
  public readonly code = 'CONVIDADO_NAO_ENCONTRADO' as const;

  constructor(
    public readonly idConvidado: IdConvidado,
    public readonly idListaDeConvidados?: IdListaDeConvidados,
  ) {
    const suffix =
      idListaDeConvidados === undefined ? '' : ` na lista de convidados ${idListaDeConvidados}`;
    super(`Convidado nao encontrado: ${idConvidado}${suffix}`);
    this.name = 'ConvidadoNaoEncontradoError';
  }
}
