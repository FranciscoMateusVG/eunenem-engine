import type { StatusPagamentoFinanceiro } from '../../../domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { IdPagamentoReferencia } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';

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
