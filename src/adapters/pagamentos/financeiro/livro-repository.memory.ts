import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdCampanha } from '../../../domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../../domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { RepasseRecebedor } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type { DadosRecebedorAtivo } from '../../../domain/pagamentos/financeiro/value-objects/dados-recebedor-ativo.js';
import type {
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
} from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../../errors/pagamentos/financeiro/pagamento-ja-registrado.error.js';
import type { RecebedorRepository } from '../../arrecadacao/recebedor-repository.js';
import type { LivroFinanceiroRepository } from './livro-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'financeiro_livro',
} as const;

/**
 * In-memory adapter. Plan 0015 reshape: status + maturaEm are gone; the
 * "state" is computed from `transferidoEm` + `canceladoEm`. Two new
 * mutations (`marcarLancamentosComoTransferidos` +
 * `marcarLancamentosComoCanceladosPorPagamento`) replace the old
 * `marcarComoDisponivel` flip; `hasLancamentosTransferidos` exposes the
 * 409-gate predicate.
 */
export class LivroFinanceiroRepositoryMemory implements LivroFinanceiroRepository {
  private readonly lancamentos = new Map<IdLancamentoFinanceiro, LancamentoFinanceiro>();
  private readonly repasses = new Map<IdRepasse, RepasseRecebedor>();

  constructor(private readonly recebedorRepository?: RecebedorRepository) {}

  async saveLancamentos(lancamentos: readonly LancamentoFinanceiro[]): Promise<void> {
    return tracer.startActiveSpan('db.financeiro_livro.lancamentos.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const idsPagamento = new Set(lancamentos.map((l) => l.idPagamento));
        for (const idPagamento of idsPagamento) {
          if (await this.temLancamentosParaPagamento(idPagamento)) {
            throw new FinanceiroPagamentoJaRegistradoError(idPagamento);
          }
        }

        for (const lancamento of lancamentos) {
          this.lancamentos.set(lancamento.id, lancamento);
        }

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findLancamentosByIdPagamento(
    idPagamento: IdPagamentoReferencia,
  ): Promise<readonly LancamentoFinanceiro[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.findByIdPagamento',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = [...this.lancamentos.values()].filter(
            (l) => l.idPagamento === idPagamento,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async findLancamentosByIds(
    ids: readonly IdLancamentoFinanceiro[],
  ): Promise<readonly LancamentoFinanceiro[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.findByIds',
      async (span) => {
        span.setAttributes({
          ...DB_ATTRS,
          'db.operation.name': 'SELECT',
          'batch.size': ids.length,
        });
        try {
          if (ids.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK });
            return [];
          }
          const set = new Set(ids);
          const result = [...this.lancamentos.values()].filter((l) => set.has(l.id));
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async findLancamentosByIdCampanha(
    idCampanha: IdCampanha,
  ): Promise<readonly LancamentoFinanceiro[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.findByIdCampanha',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = [...this.lancamentos.values()].filter((l) => l.idCampanha === idCampanha);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async findLancamentosReceitaPlataforma(): Promise<readonly LancamentoFinanceiro[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.findReceitaPlataforma',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = [...this.lancamentos.values()].filter(
            (l) => l.tipo === 'credito_receita_plataforma',
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async marcarLancamentosComoTransferidos(
    idsLancamentos: readonly IdLancamentoFinanceiro[],
    transferidoEm: Date,
  ): Promise<void> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.marcarComoTransferidos',
      async (span) => {
        span.setAttributes({
          ...DB_ATTRS,
          'db.operation.name': 'UPDATE',
          'batch.size': idsLancamentos.length,
        });
        try {
          for (const id of idsLancamentos) {
            const existing = this.lancamentos.get(id);
            if (!existing) continue;
            // Idempotent: skip rows already transferred OR cancelled —
            // matches the postgres WHERE clause exactly.
            if (existing.transferidoEm !== null || existing.canceladoEm !== null) continue;
            this.lancamentos.set(id, { ...existing, transferidoEm });
          }
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async marcarLancamentosComoCanceladosPorPagamento(
    idPagamento: IdPagamentoReferencia,
    canceladoEm: Date,
  ): Promise<void> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.marcarComoCanceladosPorPagamento',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          for (const [id, existing] of this.lancamentos.entries()) {
            if (existing.idPagamento !== idPagamento) continue;
            // Mirror postgres WHERE: skip already-cancelled, skip already-
            // transferred. Idempotent + defensive (the use-case enforces
            // the 409 gate upstream).
            if (existing.canceladoEm !== null || existing.transferidoEm !== null) continue;
            this.lancamentos.set(id, { ...existing, canceladoEm });
          }
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async hasLancamentosTransferidos(idPagamento: IdPagamentoReferencia): Promise<boolean> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.hasTransferidos',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          for (const lancamento of this.lancamentos.values()) {
            if (lancamento.idPagamento === idPagamento && lancamento.transferidoEm !== null) {
              span.setStatus({ code: SpanStatusCode.OK });
              return true;
            }
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return false;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async saveRepasse(repasse: RepasseRecebedor): Promise<void> {
    return tracer.startActiveSpan('db.financeiro_livro.repasses.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        this.repasses.set(repasse.id, repasse);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findRepasseById(idRepasse: IdRepasse): Promise<RepasseRecebedor | undefined> {
    return tracer.startActiveSpan('db.financeiro_livro.repasses.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.repasses.get(idRepasse);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findRepassesByIdCampanha(idCampanha: IdCampanha): Promise<readonly RepasseRecebedor[]> {
    return tracer.startActiveSpan('db.financeiro_livro.repasses.findByIdCampanha', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = [...this.repasses.values()].filter((r) => r.idCampanha === idCampanha);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findRecebedorAtivoPorIdCampanha(
    idCampanha: IdCampanha,
  ): Promise<DadosRecebedorAtivo | undefined> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.recebedor.findAtivoPorIdCampanha',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          if (!this.recebedorRepository) {
            span.setStatus({ code: SpanStatusCode.OK });
            return undefined;
          }
          const recebedor = await this.recebedorRepository.findAtivoByCampanhaId(idCampanha);
          span.setStatus({ code: SpanStatusCode.OK });
          return recebedor?.dadosRecebedor;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  private async temLancamentosParaPagamento(idPagamento: IdPagamentoReferencia): Promise<boolean> {
    const lancamentos = await this.findLancamentosByIdPagamento(idPagamento);
    return lancamentos.length > 0;
  }
}
