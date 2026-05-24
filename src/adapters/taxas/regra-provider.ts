import type { RegraTaxa } from '../../domain/taxas/entities/regra-taxa.js';
import type { IdPlataformaReferencia } from '../../domain/taxas/value-objects/ids.js';

/**
 * Fornece a RegraTaxa ativa de uma plataforma (porta do BC Taxas).
 *
 * Lança `RegraTaxaNaoEncontradaError` caso a plataforma não possua regra
 * cadastrada — toda plataforma operacional precisa de uma regra.
 */
export interface ProvedorRegraTaxa {
  getRegraAtiva(idPlataforma: IdPlataformaReferencia): Promise<RegraTaxa>;
}
