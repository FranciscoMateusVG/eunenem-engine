import type { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';

/**
 * Test-only helper: returns the count of receiver-balance ledger entries that
 * are eligible to be swept into a repasse for a campaign.
 *
 * Plan 0015/0016 (collapse_state_machines, migration 019): the financeiro state
 * machine was COLLAPSED. LancamentoFinanceiro no longer carries a
 * `status: pendente | disponivel` enum, AND the separate `maturaEm` maturation
 * gate is gone. State is now derived purely from `transferidoEm` + `canceladoEm`:
 *   - "a receber" / repasse-eligible  ← transferidoEm IS NULL  AND canceladoEm IS NULL
 *   - "já transferido"                ← transferidoEm IS NOT NULL AND canceladoEm IS NULL
 *
 * There is NO intermediate "matured-but-not-transferred" state anymore — a
 * recebedor lançamento is repasse-eligible the moment it's created. Stamping
 * `transferidoEm` is what `solicitarRepasseRecebedor` does when it claims the
 * row, so this helper must NOT touch it (doing so would make the row look
 * already-transferred and starve the repasse). It is now effectively a no-op
 * that just reports the eligible count, kept so the old call sites still compile.
 */
export function matureLancamentosRecebedorForCampanha(
  livroFinanceiroRepository: LivroFinanceiroRepositoryMemory,
  idCampanha: IdCampanha,
): number {
  const internalMap = (
    livroFinanceiroRepository as unknown as {
      lancamentos: Map<string, LancamentoFinanceiro>;
    }
  ).lancamentos;

  let count = 0;
  for (const lancamento of internalMap.values()) {
    if (
      lancamento.idCampanha === idCampanha &&
      lancamento.tipo === 'credito_saldo_recebedor' &&
      lancamento.transferidoEm === null &&
      lancamento.canceladoEm === null
    ) {
      count++;
    }
  }

  return count;
}
