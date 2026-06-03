/**
 * @deprecated Moved to `src/domain/pagamentos/value-objects/dados-contribuinte.ts`
 * by plan 0015 Phase 1 (aperture-7pqee). The contribuinte now lives on the
 * IntencaoPagamento (each gift attempt carries its own snapshot), not on the
 * Contribuição aggregate. This re-export stays in place for one release
 * cycle to avoid breaking external imports; update consumers and delete
 * after Phase 4.
 */
export {
  DadosContribuinteSchema,
  NomeContribuinteSchema,
  type DadosContribuinte,
} from '../../pagamentos/value-objects/dados-contribuinte.js';
