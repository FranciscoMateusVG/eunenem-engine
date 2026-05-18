import type { IdPagamento } from '../domain/pagamentos.js';

export class PagamentoNaoEncontradoError extends Error {
  public readonly code = 'PAGAMENTO_NAO_ENCONTRADO' as const;

  constructor(public readonly idPagamento: IdPagamento) {
    super(`Pagamento "${idPagamento}" nao encontrado.`);
    this.name = 'PagamentoNaoEncontradoError';
  }
}
