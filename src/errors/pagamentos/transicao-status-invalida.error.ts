import type { IdPagamento, StatusPagamento } from '../../domain/pagamentos/pagamentos.js';

export class PagamentoTransicaoStatusInvalidaError extends Error {
  public readonly code = 'PAGAMENTO_TRANSICAO_STATUS_INVALIDA' as const;

  constructor(
    public readonly idPagamento: IdPagamento,
    public readonly statusAtual: StatusPagamento,
    public readonly statusAlvo: StatusPagamento,
  ) {
    super(
      `Pagamento "${idPagamento}" nao pode transicionar de "${statusAtual}" para "${statusAlvo}".`,
    );
    this.name = 'PagamentoTransicaoStatusInvalidaError';
  }
}
