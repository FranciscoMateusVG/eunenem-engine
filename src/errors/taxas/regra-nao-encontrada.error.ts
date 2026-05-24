import type { IdPlataformaReferencia } from '../../domain/taxas/value-objects/ids.js';

export class RegraTaxaNaoEncontradaError extends Error {
  public readonly code = 'TAXAS_REGRA_NAO_ENCONTRADA' as const;

  constructor(public readonly idPlataforma: IdPlataformaReferencia) {
    super(`Regra de taxa nao encontrada para plataforma: ${idPlataforma}`);
    this.name = 'RegraTaxaNaoEncontradaError';
  }
}
