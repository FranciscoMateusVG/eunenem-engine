import { z } from 'zod/v4';
import { type IdCampanha, IdCampanhaSchema } from '../../../arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../entities/lancamento-financeiro.js';

/**
 * Value object: read-side projection of the receiver's balance for a campaign.
 * Computed from the ledger entries (`LancamentoFinanceiro[]`); not persisted.
 * Equality is structural.
 *
 * `SaldoCentavos` (a non-negative integer) is inlined here as a small bounded
 * primitive used only by this projection.
 *
 * **Plan 0015 (aperture-7pqee).** Lançamento has no more FSM. The two
 * implicit states this VO surfaces are now predicates over date columns:
 *
 *   - `valorPendenteCents` ("a receber") — money the recebedor has earned
 *     but the admin hasn't marked as transferred yet:
 *     `transferidoEm IS NULL AND canceladoEm IS NULL`.
 *   - `valorDisponivelCents` ("já transferido") — money the admin has
 *     marked as actually transferred to the recebedor:
 *     `transferidoEm IS NOT NULL AND canceladoEm IS NULL`.
 *
 * Cancelled rows (`canceladoEm IS NOT NULL`) are excluded from both
 * sums — they represent estornado pagamentos and the money never reached
 * the recebedor.
 *
 * The Phase 2 use-case (`obter-saldo-recebedor`) will switch to a SQL
 * SUM aggregation; this in-memory projection stays as a fallback for
 * the memory adapter and unit tests.
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
    .filter((l) => l.transferidoEm === null && l.canceladoEm === null)
    .reduce<SaldoCentavos>((total, l) => total + l.amountCents, 0);

  const valorDisponivelCents = lancamentosRecebedor
    .filter((l) => l.transferidoEm !== null && l.canceladoEm === null)
    .reduce<SaldoCentavos>((total, l) => total + l.amountCents, 0);

  return {
    idCampanha,
    valorPendenteCents,
    valorDisponivelCents,
  };
}
