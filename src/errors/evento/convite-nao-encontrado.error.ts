import type { IdConvite, IdEvento } from '../../domain/evento/value-objects/ids.js';

export class ConviteNaoEncontradoError extends Error {
  public readonly code = 'CONVITE_NAO_ENCONTRADO' as const;

  constructor(
    public readonly idConvite?: IdConvite,
    public readonly idEvento?: IdEvento,
  ) {
    const message =
      idConvite !== undefined
        ? `Convite nao encontrado: ${idConvite}`
        : `Convite nao encontrado para evento: ${idEvento}`;
    super(message);
    this.name = 'ConviteNaoEncontradoError';
  }
}
