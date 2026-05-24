import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { SaldoCentavos } from '../../domain/financeiro/value-objects/saldo-recebedor.js';

export class FinanceiroSaldoDisponivelInsuficienteError extends Error {
  readonly name = 'FinanceiroSaldoDisponivelInsuficienteError';

  constructor(
    public readonly idCampanha: IdCampanha,
    public readonly valorDisponivelCents: SaldoCentavos,
    public readonly valorSolicitadoCents: SaldoCentavos,
  ) {
    super(
      `Campanha "${idCampanha}" tem ${valorDisponivelCents} centavos disponiveis, ` +
        `mas o repasse solicitado e de ${valorSolicitadoCents} centavos.`,
    );
  }
}
