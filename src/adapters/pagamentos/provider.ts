import type { MoneyCents } from '../../domain/money.js';
import type { TransacaoExterna } from '../../domain/pagamentos/entities/pagamento.js';
import type {
  IdIntencaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';
import type { MetodoPagamento } from '../../domain/pagamentos/value-objects/metodo-pagamento.js';

export interface SolicitarPagamentoInput {
  readonly idPagamento: IdPagamento;
  readonly idIntencaoPagamento: IdIntencaoPagamento;
  readonly amountCents: MoneyCents;
  readonly metodo: MetodoPagamento;
}

/**
 * Provedor de pagamento (porta). Por enquanto, será implementado por um fake.
 */
export interface PagamentoProvider {
  solicitarPagamento(input: SolicitarPagamentoInput): Promise<TransacaoExterna>;
}
