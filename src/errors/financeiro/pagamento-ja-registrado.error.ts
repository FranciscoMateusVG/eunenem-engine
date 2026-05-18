import type { IdPagamentoReferencia } from '../../domain/financeiro/financeiro.js';

export class FinanceiroPagamentoJaRegistradoError extends Error {
  public readonly code = 'FINANCEIRO_PAGAMENTO_JA_REGISTRADO' as const;

  constructor(public readonly idPagamento: IdPagamentoReferencia) {
    super(`Pagamento "${idPagamento}" ja possui lancamentos financeiros registrados.`);
    this.name = 'FinanceiroPagamentoJaRegistradoError';
  }
}
