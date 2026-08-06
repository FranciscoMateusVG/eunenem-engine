export type FinanceiroMovimentacaoSolicitada = 'devolucao' | 'transferencia';

/**
 * Categorical money-movement exclusion error. It intentionally carries only
 * the payment identifier and requested operation; no payer or receiver PII.
 */
export class FinanceiroPagamentoMovimentacaoConflitanteError extends Error {
  public readonly code = 'FINANCEIRO_PAGAMENTO_MOVIMENTACAO_CONFLITANTE' as const;

  constructor(
    public readonly idPagamento: string,
    public readonly operacaoSolicitada: FinanceiroMovimentacaoSolicitada,
  ) {
    super(
      `Pagamento "${idPagamento}" possui movimentacao financeira incompatível com ${operacaoSolicitada}.`,
    );
    this.name = 'FinanceiroPagamentoMovimentacaoConflitanteError';
  }
}
