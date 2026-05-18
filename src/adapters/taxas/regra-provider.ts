import type { RegraTaxa } from '../../domain/taxas/taxas.js';

/**
 * Fornece a regra de taxa ativa (porta do BC Taxas).
 */
export interface ProvedorRegraTaxa {
  getRegraAtiva(): Promise<RegraTaxa>;
}
