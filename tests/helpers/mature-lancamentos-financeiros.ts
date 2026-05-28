import type { LivroFinanceiroRepositoryMemory } from '../../src/adapters/financeiro/livro-repository.memory.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../src/domain/financeiro/entities/lancamento-financeiro.js';

/**
 * Test-only helper: flips receiver-balance ledger entries from `pendente` to
 * `disponivel` for a campaign.
 *
 * In production, maturation would be a domain rule (e.g. D+30 after payment).
 * The engine does not expose that use case yet — this helper lets integration
 * tests exercise the repasse step without waiting for a real maturation pipeline.
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
  for (const [id, lancamento] of internalMap) {
    if (
      lancamento.idCampanha === idCampanha &&
      lancamento.tipo === 'credito_saldo_recebedor' &&
      lancamento.status === 'pendente'
    ) {
      internalMap.set(id, { ...lancamento, status: 'disponivel' });
      count++;
    }
  }

  return count;
}
