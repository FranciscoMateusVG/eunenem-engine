import type { MoneyCents } from '../domain/money.js';
import type {
  IdIntencaoPagamento,
  IdPagamento,
  MetodoPagamento,
  TransacaoExterna,
} from '../domain/pagamentos.js';

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
