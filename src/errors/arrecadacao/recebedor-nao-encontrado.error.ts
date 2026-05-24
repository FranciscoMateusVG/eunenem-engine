import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

export class ArrecadacaoRecebedorNaoEncontradoError extends Error {
  constructor(public readonly idCampanha: IdCampanha) {
    super(`Recebedor ativo da campanha "${idCampanha}" nao encontrado.`);
    this.name = 'ArrecadacaoRecebedorNaoEncontradoError';
  }
}
