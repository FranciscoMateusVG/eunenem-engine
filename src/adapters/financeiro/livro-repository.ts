import type { IdCampanha } from '../../domain/arrecadacao/campanha.js';
import type {
  DadosRecebedorAtivo,
  IdPagamentoReferencia,
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
  findLancamentosByIdCampanha(idCampanha: IdCampanha): Promise<readonly LancamentoFinanceiro[]>;
  findLancamentosReceitaPlataforma(): Promise<readonly LancamentoFinanceiro[]>;
  saveRepasse(repasse: RepasseRecebedor): Promise<void>;
  findRepasseById(idRepasse: IdRepasse): Promise<RepasseRecebedor | undefined>;
  findRepassesByIdCampanha(idCampanha: IdCampanha): Promise<readonly RepasseRecebedor[]>;
  findRecebedorAtivoPorIdCampanha(idCampanha: IdCampanha): Promise<DadosRecebedorAtivo | undefined>;
}
