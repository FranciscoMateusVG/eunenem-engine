import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../domain/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../domain/financeiro/entities/repasse-recebedor.js';
import type { DadosRecebedorAtivo } from '../../domain/financeiro/value-objects/dados-recebedor-ativo.js';
import type {
  IdPagamentoReferencia,
  IdRepasse,
} from '../../domain/financeiro/value-objects/ids.js';

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
