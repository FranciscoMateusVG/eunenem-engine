import type { IdPagamento, Pagamento } from '../../domain/pagamentos/pagamentos.js';

/**
 * Persistência de Pagamentos (porta).
 */
export interface PagamentoRepository {
  save(pagamento: Pagamento): Promise<void>;
  update(pagamento: Pagamento): Promise<void>;
  findById(id: IdPagamento): Promise<Pagamento | undefined>;
}
