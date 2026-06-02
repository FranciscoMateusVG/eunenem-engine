import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../domain/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../domain/financeiro/entities/repasse-recebedor.js';
import type { DadosRecebedorAtivo } from '../../domain/financeiro/value-objects/dados-recebedor-ativo.js';
import type {
  IdLancamentoFinanceiro,
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
  /**
   * Returns all `pendente` lancamentos whose `maturaEm` is ≤ `now`
   * (aperture-led0r). Tenant-agnostic — the maturation job runs
   * system-wide. The postgres adapter uses the partial index
   * `lancamentos_pendentes_maturos_idx` ON (matura_em) WHERE
   * status='pendente' for selective scan.
   */
  findPendentesMaturos(now: Date): Promise<readonly LancamentoFinanceiro[]>;
  /**
   * Flip a single lancamento from `pendente` to `disponivel`
   * (aperture-led0r). Idempotent: calling on an already-disponivel
   * row is a no-op (UPDATE matches zero rows). Used by
   * `maturarLancamentosPendentes` to flip matured rows one at a time
   * with per-row audit logging.
   */
  marcarComoDisponivel(idLancamento: IdLancamentoFinanceiro): Promise<void>;
  saveRepasse(repasse: RepasseRecebedor): Promise<void>;
  findRepasseById(idRepasse: IdRepasse): Promise<RepasseRecebedor | undefined>;
  findRepassesByIdCampanha(idCampanha: IdCampanha): Promise<readonly RepasseRecebedor[]>;
  findRecebedorAtivoPorIdCampanha(idCampanha: IdCampanha): Promise<DadosRecebedorAtivo | undefined>;
}
