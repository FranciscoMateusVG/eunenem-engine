import type { IdPagamentoReferencia, StatusPagamentoFinanceiro } from '../domain/financeiro.js';

export class FinanceiroPagamentoNaoAprovadoError extends Error {
  public readonly code = 'FINANCEIRO_PAGAMENTO_NAO_APROVADO' as const;

  constructor(
    public readonly idPagamento: IdPagamentoReferencia,
    public readonly status: StatusPagamentoFinanceiro,
  ) {
    super(`Pagamento "${idPagamento}" esta "${status}" e nao pode gerar lancamentos financeiros.`);
    this.name = 'FinanceiroPagamentoNaoAprovadoError';
  }
}
