import type { RegraTaxa } from '../../domain/taxas/value-objects/regra-taxa.js';

/**
 * Fornece a regra de taxa ativa (porta do BC Taxas).
 */
export interface ProvedorRegraTaxa {
  getRegraAtiva(): Promise<RegraTaxa>;
}
