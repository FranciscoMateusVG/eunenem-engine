import { z } from 'zod/v4';
import type { LancamentoFinanceiro } from '../entities/lancamento-financeiro.js';
import { type SaldoCentavos, SaldoCentavosSchema } from './saldo-recebedor.js';

/**
 * Value object: read-side projection of total platform revenue. Computed by
 * summing `credito_receita_plataforma` entries from the ledger. Not persisted.
 */
export const ReceitaPlataformaSchema = z.object({
  totalAmountCents: SaldoCentavosSchema,
});

export type ReceitaPlataforma = Readonly<z.infer<typeof ReceitaPlataformaSchema>>;

export function calcularReceitaPlataforma(
  lancamentos: readonly LancamentoFinanceiro[],
): ReceitaPlataforma {
  const totalAmountCents = lancamentos
    .filter((l) => l.tipo === 'credito_receita_plataforma')
    .reduce<SaldoCentavos>((total, l) => total + l.amountCents, 0);

  return { totalAmountCents };
}
