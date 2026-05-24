import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import type { IdPagamento } from '../../domain/pagamentos/value-objects/ids.js';

/**
 * Persistência de Pagamentos (porta).
 */
export interface PagamentoRepository {
  save(pagamento: Pagamento): Promise<void>;
  update(pagamento: Pagamento): Promise<void>;
  findById(id: IdPagamento): Promise<Pagamento | undefined>;
}
