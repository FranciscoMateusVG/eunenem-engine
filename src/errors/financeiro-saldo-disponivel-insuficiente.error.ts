import type { IdRecebedorFinanceiro, SaldoCentavos } from '../domain/financeiro.js';
import type { MoneyCents } from '../domain/money.js';

export class FinanceiroSaldoDisponivelInsuficienteError extends Error {
  public readonly code = 'FINANCEIRO_SALDO_DISPONIVEL_INSUFICIENTE' as const;

  constructor(
    public readonly idRecebedor: IdRecebedorFinanceiro,
    public readonly valorSolicitadoCents: MoneyCents,
    public readonly valorDisponivelCents: SaldoCentavos,
  ) {
    super(
      `Recebedor "${idRecebedor}" tem ${valorDisponivelCents} centavos disponiveis, ` +
        `mas foram solicitados ${valorSolicitadoCents} centavos.`,
    );
    this.name = 'FinanceiroSaldoDisponivelInsuficienteError';
  }
}
