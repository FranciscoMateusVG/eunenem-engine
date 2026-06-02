import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import type {
  IdContribuicaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentoJaExisteError } from '../../errors/pagamentos/ja-existe.error.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import type { PagamentoRepository } from './repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'pagamentos',
} as const;

export class PagamentoRepositoryMemory implements PagamentoRepository {
  private readonly pagamentos = new Map<IdPagamento, Pagamento>();

  async save(pagamento: Pagamento): Promise<void> {
    return tracer.startActiveSpan('db.pagamentos.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        if (this.pagamentos.has(pagamento.id)) {
          throw new PagamentoJaExisteError(pagamento.id, pagamento.intencao.id);
        }

        this.pagamentos.set(pagamento.id, pagamento);
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

  async update(pagamento: Pagamento): Promise<void> {
    return tracer.startActiveSpan('db.pagamentos.update', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        if (!this.pagamentos.has(pagamento.id)) {
          throw new PagamentoNaoEncontradoError(pagamento.id);
        }

        this.pagamentos.set(pagamento.id, pagamento);
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

  async findById(id: IdPagamento): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan('db.pagamentos.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.pagamentos.get(id);
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

  /**
   * Linear scan over the in-memory map (aperture-i0pz8). Filters by
   * `intencao.idContribuicao` and returns ALL matches in `criadoEm ASC`
   * order — a single contribuicao may have multiple pagamentos over
   * time (retries after rejection, saga reprocessing).
   */
  async findByContribuicao(idContribuicao: IdContribuicaoPagamento): Promise<readonly Pagamento[]> {
    return tracer.startActiveSpan('db.pagamentos.findByContribuicao', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const matches: Pagamento[] = [];
        for (const pagamento of this.pagamentos.values()) {
          if (pagamento.intencao.idContribuicao === idContribuicao) {
            matches.push(pagamento);
          }
        }
        matches.sort((a, b) => a.criadoEm.getTime() - b.criadoEm.getTime());
        span.setStatus({ code: SpanStatusCode.OK });
        return matches;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Linear scan over the in-memory map (aperture-xaha2). Fine for tests
   * and learning examples — the Postgres adapter uses an indexed query.
   * Returns the first match (externalRef is logically unique).
   */
  async findByExternalRef(externalRef: string): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan('db.pagamentos.findByExternalRef', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        for (const pagamento of this.pagamentos.values()) {
          if (pagamento.intencao.externalRef === externalRef) {
            span.setStatus({ code: SpanStatusCode.OK });
            return pagamento;
          }
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByPaymentIntentExternalRef(pi: string): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan(
      'db.pagamentos.findByPaymentIntentExternalRef',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          for (const pagamento of this.pagamentos.values()) {
            if (pagamento.intencao.paymentIntentExternalRef === pi) {
              span.setStatus({ code: SpanStatusCode.OK });
              return pagamento;
            }
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
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

  async findByChargeExternalRef(ch: string): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan(
      'db.pagamentos.findByChargeExternalRef',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          for (const pagamento of this.pagamentos.values()) {
            if (pagamento.intencao.chargeExternalRef === ch) {
              span.setStatus({ code: SpanStatusCode.OK });
              return pagamento;
            }
          }
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
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
}
