import type { MoneyCents } from '../domain/money.js';

export class PagamentoValorDivergenteError extends Error {
  public readonly code = 'PAGAMENTO_VALOR_DIVERGENTE' as const;

  constructor(
    public readonly valorEsperadoCents: MoneyCents,
    public readonly valorRecebidoCents: MoneyCents,
  ) {
    super(
      `Valor do pagamento divergente: esperado ${valorEsperadoCents} centavos, recebido ${valorRecebidoCents} centavos.`,
    );
    this.name = 'PagamentoValorDivergenteError';
  }
}
