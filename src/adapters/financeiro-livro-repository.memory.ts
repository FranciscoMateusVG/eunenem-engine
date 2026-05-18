import { SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRecebedorFinanceiro,
  IdRepasse,
  LancamentoFinanceiro,
  RepasseRecebedor,
} from '../domain/financeiro.js';
import { FinanceiroPagamentoJaRegistradoError } from '../errors/financeiro-pagamento-ja-registrado.error.js';
import type { LivroFinanceiroRepository } from './financeiro-livro-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'financeiro_livro',
} as const;

export class LivroFinanceiroRepositoryMemory implements LivroFinanceiroRepository {
  private readonly lancamentos = new Map<IdLancamentoFinanceiro, LancamentoFinanceiro>();
  private readonly repasses = new Map<IdRepasse, RepasseRecebedor>();

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

  async findLancamentosByIdRecebedor(
    idRecebedor: IdRecebedorFinanceiro,
  ): Promise<readonly LancamentoFinanceiro[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.findByIdRecebedor',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = [...this.lancamentos.values()].filter(
            (l) => l.idRecebedor === idRecebedor,
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

  async findRepassesByIdRecebedor(
    idRecebedor: IdRecebedorFinanceiro,
  ): Promise<readonly RepasseRecebedor[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.findByIdRecebedor',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = [...this.repasses.values()].filter((r) => r.idRecebedor === idRecebedor);
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

  private async temLancamentosParaPagamento(idPagamento: IdPagamentoReferencia): Promise<boolean> {
    const lancamentos = await this.findLancamentosByIdPagamento(idPagamento);
    return lancamentos.length > 0;
  }
}
