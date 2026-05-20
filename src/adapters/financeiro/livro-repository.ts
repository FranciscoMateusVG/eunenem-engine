import type {
  IdPagamentoReferencia,
  IdRecebedorFinanceiro,
  IdRepasse,
  LancamentoFinanceiro,
  RepasseRecebedor,
} from '../../domain/financeiro/financeiro.js';

/**
 * Persistência do livro financeiro (porta).
 */
export interface LivroFinanceiroRepository {
  saveLancamentos(lancamentos: readonly LancamentoFinanceiro[]): Promise<void>;
  findLancamentosByIdPagamento(
    idPagamento: IdPagamentoReferencia,
  ): Promise<readonly LancamentoFinanceiro[]>;
  findLancamentosByIdRecebedor(
    idRecebedor: IdRecebedorFinanceiro,
  ): Promise<readonly LancamentoFinanceiro[]>;
  findLancamentosReceitaPlataforma(): Promise<readonly LancamentoFinanceiro[]>;
  saveRepasse(repasse: RepasseRecebedor): Promise<void>;
  findRepasseById(idRepasse: IdRepasse): Promise<RepasseRecebedor | undefined>;
  findRepassesByIdRecebedor(
    idRecebedor: IdRecebedorFinanceiro,
  ): Promise<readonly RepasseRecebedor[]>;
}
