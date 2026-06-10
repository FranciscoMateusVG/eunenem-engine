import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { Pagamento } from '../../domain/pagamentos/entities/pagamento.js';
import type {
  IdContribuicaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentoJaExisteError } from '../../errors/pagamentos/ja-existe.error.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import type { MuralRecadoProjection, PagamentoRepository } from './repository.js';

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
   * Linear scan (aperture-i0pz8 + plan 0016 / aperture-eg1s2 reshape).
   * Post-0016 a pagamento carries a multi-item cart; a "match" means
   * ANY contribuicao-tipo item references the given idContribuicao.
   * Returns ALL matching pagamentos in `criadoEm ASC` order.
   */
  async findByContribuicao(idContribuicao: IdContribuicaoPagamento): Promise<readonly Pagamento[]> {
    return tracer.startActiveSpan('db.pagamentos.findByContribuicao', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const matches: Pagamento[] = [];
        for (const pagamento of this.pagamentos.values()) {
          const hit = pagamento.intencao.items.some(
            (item) => item.tipo === 'contribuicao' && item.idContribuicao === idContribuicao,
          );
          if (hit) {
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
    return tracer.startActiveSpan('db.pagamentos.findByPaymentIntentExternalRef', async (span) => {
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
    });
  }

  async findByChargeExternalRef(ch: string): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan('db.pagamentos.findByChargeExternalRef', async (span) => {
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
    });
  }

  /**
   * Plan 0016 Phase 2 (aperture-eg1s2). Linear scan over the in-memory
   * map: for each input id, sums `quantidade` across all
   * contribuição-tipo items of aprovado pagamentos. Returns a Map with
   * every input key (zeros for misses) — same contract as the postgres
   * adapter.
   */
  async somarQuantidadesContribuicoesEmPagamentosAprovados(
    idsContribuicao: readonly IdContribuicaoPagamento[],
  ): Promise<Map<IdContribuicaoPagamento, number>> {
    return tracer.startActiveSpan(
      'db.pagamentos.somarQuantidadesContribuicoesEmPagamentosAprovados',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = new Map<IdContribuicaoPagamento, number>();
          for (const id of idsContribuicao) {
            result.set(id, 0);
          }
          if (idsContribuicao.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          }
          const candidates = new Set<IdContribuicaoPagamento>(idsContribuicao);
          for (const pagamento of this.pagamentos.values()) {
            if (pagamento.status !== 'aprovado') continue;
            for (const item of pagamento.intencao.items) {
              if (item.tipo !== 'contribuicao') continue;
              const idC = item.idContribuicao;
              if (!candidates.has(idC)) continue;
              result.set(idC, (result.get(idC) ?? 0) + item.quantidade);
            }
          }
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

  /**
   * Plan 0015 (aperture-6iqum). Linear scan: for each idContribuicao,
   * find the most-recent aprovado pagamento (by criadoEm DESC) and
   * return its intencao.contribuinte. Keys absent from the Map mean
   * NO aprovado pagamento exists for that idContribuicao; null entry
   * means an aprovado pagamento exists but contribuinte was never
   * populated (anonymous checkout).
   */
  async findContribuintesFromLatestAprovadoPagamento(
    idsContribuicao: readonly IdContribuicaoPagamento[],
  ): Promise<Map<string, { nome: string; email: string; mensagem?: string } | null>> {
    return tracer.startActiveSpan(
      'db.pagamentos.findContribuintesFromLatestAprovadoPagamento',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = new Map<
            string,
            { nome: string; email: string; mensagem?: string } | null
          >();
          if (idsContribuicao.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          }
          const candidates = new Set<string>(idsContribuicao);
          // Group aprovado pagamentos by idContribuicao, keeping the
          // most-recent one (by criadoEm). Post-0016 a pagamento can
          // hold multiple contribuição-tipo items; we visit each item
          // and consider the pagamento a "winner" for each
          // contribuição id it carries (the same pagamento can be the
          // winner for several ids in a multi-item cart).
          const winners = new Map<string, Pagamento>();
          for (const pagamento of this.pagamentos.values()) {
            if (pagamento.status !== 'aprovado') continue;
            for (const item of pagamento.intencao.items) {
              if (item.tipo !== 'contribuicao') continue;
              const idC = item.idContribuicao as unknown as string;
              if (!candidates.has(idC)) continue;
              const current = winners.get(idC);
              if (
                current === undefined ||
                pagamento.criadoEm.getTime() > current.criadoEm.getTime()
              ) {
                winners.set(idC, pagamento);
              }
            }
          }
          for (const [idC, pagamento] of winners.entries()) {
            const contribuinte = pagamento.intencao.contribuinte;
            if (contribuinte === null) {
              result.set(idC, null);
            } else {
              result.set(idC, {
                nome: contribuinte.nome,
                email: contribuinte.email,
                ...(contribuinte.mensagem !== undefined ? { mensagem: contribuinte.mensagem } : {}),
              });
            }
          }
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

  /**
   * aperture-7eci9 — visitor mural read. Linear scan over the in-memory
   * map; matches the postgres adapter contract: status='aprovado' AND
   * intencao.contribuinte non-null AND a non-empty mensagem string,
   * scoped to the given campanha, ordered newest-first, capped at limit.
   */
  async findMensagensMuralByCampanha(
    idCampanha: IdCampanha,
    limit: number,
  ): Promise<readonly MuralRecadoProjection[]> {
    return tracer.startActiveSpan(
      'db.pagamentos.findMensagensMuralByCampanha',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const matches: MuralRecadoProjection[] = [];
          for (const pagamento of this.pagamentos.values()) {
            if (pagamento.status !== 'aprovado') continue;
            if (pagamento.intencao.idCampanha !== idCampanha) continue;
            const contribuinte = pagamento.intencao.contribuinte;
            if (contribuinte === null) continue;
            const mensagem = contribuinte.mensagem;
            if (typeof mensagem !== 'string' || mensagem.trim().length === 0) {
              continue;
            }
            matches.push({
              idPagamento: pagamento.id,
              contribuinteNome: contribuinte.nome,
              mensagem,
              criadoEm: pagamento.criadoEm,
            });
          }
          matches.sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime());
          const capped = matches.slice(0, Math.max(0, limit));
          span.setStatus({ code: SpanStatusCode.OK });
          return capped;
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
