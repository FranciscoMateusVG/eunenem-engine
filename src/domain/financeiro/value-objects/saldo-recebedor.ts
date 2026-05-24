import { z } from 'zod/v4';
import { type IdCampanha, IdCampanhaSchema } from '../../arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../entities/lancamento-financeiro.js';

/**
 * Value object: read-side projection of the receiver's balance for a campaign.
 * Computed from the ledger entries (`LancamentoFinanceiro[]`); not persisted.
 * Equality is structural.
 *
 * `SaldoCentavos` (a non-negative integer) is inlined here as a small bounded
 * primitive used only by this projection.
 */

export const SaldoCentavosSchema = z.number().int().min(0);
export type SaldoCentavos = z.infer<typeof SaldoCentavosSchema>;

export const SaldoRecebedorSchema = z.object({
  idCampanha: IdCampanhaSchema,
  valorPendenteCents: SaldoCentavosSchema,
  valorDisponivelCents: SaldoCentavosSchema,
});

export type SaldoRecebedor = Readonly<z.infer<typeof SaldoRecebedorSchema>>;

export function calcularSaldoRecebedor(
  idCampanha: IdCampanha,
  lancamentos: readonly LancamentoFinanceiro[],
): SaldoRecebedor {
  const lancamentosRecebedor = lancamentos.filter(
    (l) => l.tipo === 'credito_saldo_recebedor' && l.idCampanha === idCampanha,
  );

  const valorPendenteCents = lancamentosRecebedor
    .filter((l) => l.status === 'pendente')
    .reduce<SaldoCentavos>((total, l) => total + l.amountCents, 0);

  const valorDisponivelCents = lancamentosRecebedor
    .filter((l) => l.status === 'disponivel')
    .reduce<SaldoCentavos>((total, l) => total + l.amountCents, 0);

  return {
    idCampanha,
    valorPendenteCents,
    valorDisponivelCents,
  };
}
