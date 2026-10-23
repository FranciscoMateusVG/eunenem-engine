import type { AcaoCampanha } from '../../domain/arrecadacao/value-objects/permissao-campanha.js';

/**
 * O caller administra a campanha (ou não), mas NÃO tem a permissão da ação
 * pedida (aperture-1z18g). A camada HTTP mapeia para `FORBIDDEN`.
 */
export class CampanhaPermissaoNegadaError extends Error {
  public readonly code = 'CAMPANHA_PERMISSAO_NEGADA' as const;

  constructor(public readonly acao: AcaoCampanha) {
    super(`Sem permissao para "${acao}" nesta campanha.`);
    this.name = 'CampanhaPermissaoNegadaError';
  }
}
