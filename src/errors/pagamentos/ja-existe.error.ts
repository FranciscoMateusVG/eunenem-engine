import type { IdIntencaoPagamento, IdPagamento } from '../../domain/pagamentos/pagamentos.js';

export class PagamentoJaExisteError extends Error {
  public readonly code = 'PAGAMENTO_JA_EXISTE' as const;

  constructor(
    public readonly idPagamento: IdPagamento,
    public readonly idIntencaoPagamento?: IdIntencaoPagamento,
  ) {
    const suffix = idIntencaoPagamento ? ` ou intencao "${idIntencaoPagamento}"` : '';
    super(`Pagamento "${idPagamento}"${suffix} ja existe.`);
    this.name = 'PagamentoJaExisteError';
  }
}
