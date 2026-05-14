import type { FeeRule } from '../domain/fees.js';

/**
 * Fornece a regra de taxa ativa (porta do BC Taxas).
 */
export interface FeeRuleProvider {
  getActiveRule(): Promise<FeeRule>;
}
