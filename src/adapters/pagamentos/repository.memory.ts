import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import type { Pagamento, StatusPagamento } from '../../domain/pagamentos/entities/pagamento.js';
import type { DadosContribuinte } from '../../domain/pagamentos/value-objects/dados-contribuinte.js';
import type {
  IdContribuicaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentoJaExisteError } from '../../errors/pagamentos/ja-existe.error.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import { PagamentoProviderProjectionConflictError } from '../../errors/pagamentos/provider-projection-conflict.error.js';
import type {
  AdminRecadoRow,
  ClaimPixCobrancaProviderReadByTxidInput,
  ClaimPixCobrancaReconciliationCandidatesInput,
  MuralRecadoProjection,
  PagamentoProviderProjection,
  PagamentoRepository,
  PixCobrancaReconciliationCandidate,
} from './repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'pagamentos',
} as const;

export class PagamentoRepositoryMemory implements PagamentoRepository {
  private readonly pagamentos = new Map<IdPagamento, Pagamento>();
  /**
   * aperture-16wrk / 5v766 Phase A — side-table holding the
   * `pagamentos.mensagem_lida_em` column the postgres adapter
   * persists. Kept off the Pagamento aggregate (the aggregate doesn't
   * model admin read-state) so the in-memory shape mirrors the
   * postgres column without forcing every test fixture to thread a
   * `mensagemLidaEm` field through Pagamento literals.
   *
   * Keyed by `idPagamento`. Absent key = NULL = unread. Set value =
   * the timestamp the admin marked-as-read; first-write-wins.
   */
  private readonly mensagemLidaEmByIdPagamento = new Map<IdPagamento, Date>();
  /** Operational lease state; deliberately kept outside the aggregate. */
  private readonly pixReconciliacaoClaimedUntilByIdPagamento = new Map<IdPagamento, Date>();

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

  async setContribuinteIfAbsent(
    idPagamento: IdPagamento,
    contribuinte: DadosContribuinte,
    atualizadoEm: Date,
  ): Promise<boolean> {
    return tracer.startActiveSpan('db.pagamentos.setContribuinteIfAbsent', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const persisted = this.pagamentos.get(idPagamento);
        if (persisted === undefined || persisted.intencao.contribuinte !== null) {
          span.setStatus({ code: SpanStatusCode.OK });
          return false;
        }
        this.pagamentos.set(idPagamento, {
          ...persisted,
          intencao: { ...persisted.intencao, contribuinte },
          atualizadoEm,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return true;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async updateProviderProjection(
    idPagamento: IdPagamento,
    projection: PagamentoProviderProjection,
    atualizadoEm: Date,
  ): Promise<Pagamento | undefined> {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one atomic projection validates and merges three independently optional fields
    return tracer.startActiveSpan('db.pagamentos.updateProviderProjection', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const persisted = this.pagamentos.get(idPagamento);
        if (!persisted) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        if (
          projection.paymentIntentExternalRef != null &&
          persisted.intencao.paymentIntentExternalRef != null &&
          persisted.intencao.paymentIntentExternalRef !== projection.paymentIntentExternalRef
        ) {
          throw new PagamentoProviderProjectionConflictError('paymentIntentExternalRef');
        }
        if (
          projection.chargeExternalRef != null &&
          persisted.intencao.chargeExternalRef != null &&
          persisted.intencao.chargeExternalRef !== projection.chargeExternalRef
        ) {
          throw new PagamentoProviderProjectionConflictError('chargeExternalRef');
        }
        if (
          projection.balanceTransactionAvailableOn != null &&
          persisted.intencao.balanceTransactionAvailableOn != null &&
          persisted.intencao.balanceTransactionAvailableOn.getTime() !==
            projection.balanceTransactionAvailableOn.getTime()
        ) {
          span.addEvent('provider_projection.available_on_mismatch');
        }
        const updated: Pagamento = {
          ...persisted,
          intencao: {
            ...persisted.intencao,
            ...('paymentIntentExternalRef' in projection
              ? {
                  paymentIntentExternalRef:
                    persisted.intencao.paymentIntentExternalRef ??
                    projection.paymentIntentExternalRef ??
                    null,
                }
              : {}),
            ...('chargeExternalRef' in projection
              ? {
                  chargeExternalRef:
                    persisted.intencao.chargeExternalRef ?? projection.chargeExternalRef ?? null,
                }
              : {}),
            ...('balanceTransactionAvailableOn' in projection
              ? {
                  balanceTransactionAvailableOn:
                    persisted.intencao.balanceTransactionAvailableOn ??
                    projection.balanceTransactionAvailableOn ??
                    null,
                }
              : {}),
          },
          atualizadoEm,
        };
        this.pagamentos.set(idPagamento, updated);
        span.setStatus({ code: SpanStatusCode.OK });
        return updated;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async updateIfStatusIn(
    pagamento: Pagamento,
    expectedStatuses: readonly StatusPagamento[],
  ): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan('db.pagamentos.updateIfStatusIn', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const persisted = this.pagamentos.get(pagamento.id);
        if (persisted === undefined || !expectedStatuses.includes(persisted.status)) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        // Lifecycle CAS owns lifecycle/provider columns, not the separately
        // claimed contributor projection. Preserve the canonical contributor
        // even when the caller built this aggregate from a stale null read.
        const updated: Pagamento = {
          ...pagamento,
          intencao: {
            ...pagamento.intencao,
            contribuinte: persisted.intencao.contribuinte,
          },
        };
        this.pagamentos.set(pagamento.id, updated);
        span.setStatus({ code: SpanStatusCode.OK });
        return updated;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async claimPixCobrancaProviderReadByTxid(
    input: ClaimPixCobrancaProviderReadByTxidInput,
  ): Promise<IdPagamento | undefined> {
    return tracer.startActiveSpan(
      'db.pagamentos.claimPixCobrancaProviderReadByTxid',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          const pagamento = [...this.pagamentos.values()].find(
            (candidate) => candidate.intencao.externalRef === input.txid,
          );
          const lease = pagamento
            ? this.pixReconciliacaoClaimedUntilByIdPagamento.get(pagamento.id)
            : undefined;
          const persistedTransaction = pagamento?.transacaoExterna;
          const awaitingSettlement =
            pagamento?.status === 'pendente' || pagamento?.status === 'processing';
          const exactApprovedReplay =
            pagamento?.status === 'aprovado' &&
            pagamento.intencao.e2eExternalRef === input.e2eId &&
            persistedTransaction?.provedor === 'inter' &&
            persistedTransaction.id === input.e2eId &&
            persistedTransaction.status === 'aprovado';
          const eligible =
            pagamento !== undefined &&
            pagamento.intencao.externalRef === pagamento.id.replaceAll('-', '') &&
            pagamento.intencao.metodo === 'pix' &&
            (awaitingSettlement || exactApprovedReplay) &&
            (lease === undefined || lease.getTime() <= input.now.getTime());

          if (!eligible || pagamento === undefined) {
            span.setStatus({ code: SpanStatusCode.OK });
            return undefined;
          }

          // No await occurs between eligibility and the write, mirroring the
          // atomic UPDATE used by PostgreSQL for concurrent callers.
          this.pixReconciliacaoClaimedUntilByIdPagamento.set(
            pagamento.id,
            new Date(input.leaseUntil),
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return pagamento.id;
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

  async claimPixCobrancaReconciliationCandidates(
    input: ClaimPixCobrancaReconciliationCandidatesInput,
  ): Promise<readonly PixCobrancaReconciliationCandidate[]> {
    return tracer.startActiveSpan(
      'db.pagamentos.claimPixCobrancaReconciliationCandidates',
      async (span) => {
        span.setAttributes({
          ...DB_ATTRS,
          'db.operation.name': 'UPDATE',
          'batch.size': input.limit,
        });
        try {
          if (input.limit <= 0) {
            span.setStatus({ code: SpanStatusCode.OK });
            return [];
          }

          const candidates = [...this.pagamentos.values()]
            .filter((pagamento) => {
              const expiry = pagamento.intencao.expiraEm;
              const lease = this.pixReconciliacaoClaimedUntilByIdPagamento.get(pagamento.id);
              return (
                (pagamento.status === 'pendente' || pagamento.status === 'processing') &&
                pagamento.intencao.metodo === 'pix' &&
                expiry !== null &&
                expiry.getTime() <= input.now.getTime() &&
                pagamento.intencao.externalRef === pagamento.id.replaceAll('-', '') &&
                (lease === undefined || lease.getTime() <= input.now.getTime())
              );
            })
            .sort((a, b) => {
              const byExpiry =
                // The filter above proves both values are non-null.
                (a.intencao.expiraEm as Date).getTime() - (b.intencao.expiraEm as Date).getTime();
              return byExpiry !== 0 ? byExpiry : a.id.localeCompare(b.id);
            })
            .slice(0, input.limit);

          const claimed = candidates.map((pagamento) => {
            this.pixReconciliacaoClaimedUntilByIdPagamento.set(pagamento.id, input.leaseUntil);
            return {
              idPagamento: pagamento.id,
              txid: pagamento.intencao.externalRef as string,
              expiraEm: pagamento.intencao.expiraEm as Date,
            };
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return claimed;
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

  async releasePixCobrancaReconciliationClaim(
    idPagamento: IdPagamento,
    claimedUntil: Date,
  ): Promise<boolean> {
    return tracer.startActiveSpan(
      'db.pagamentos.releasePixCobrancaReconciliationClaim',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          const persisted = this.pixReconciliacaoClaimedUntilByIdPagamento.get(idPagamento);
          if (persisted === undefined || persisted.getTime() !== claimedUntil.getTime()) {
            span.setStatus({ code: SpanStatusCode.OK });
            return false;
          }
          this.pixReconciliacaoClaimedUntilByIdPagamento.delete(idPagamento);
          span.setStatus({ code: SpanStatusCode.OK });
          return true;
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

  async findByE2eExternalRef(e2eId: string): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan('db.pagamentos.findByE2eExternalRef', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        for (const pagamento of this.pagamentos.values()) {
          if (pagamento.intencao.e2eExternalRef === e2eId) {
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
    return tracer.startActiveSpan('db.pagamentos.findMensagensMuralByCampanha', async (span) => {
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
    });
  }

  /**
   * aperture-16wrk / 5v766 Phase A — admin mensagens raw row read.
   * Linear scan with the same filter shape as the mural; surfaces
   * `lidaEm` (from the side-map), `valorContribuicaoCents` (from
   * the aggregate composição), and `idPrimeiraContribuicao` (from
   * the first contribuição-tipo item by position) for the use-case
   * to decorate with the contribuição NAME.
   */
  async findRecadosAdminByCampanha(idCampanha: IdCampanha): Promise<readonly AdminRecadoRow[]> {
    return tracer.startActiveSpan('db.pagamentos.findRecadosAdminByCampanha', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const matches: AdminRecadoRow[] = [];
        for (const pagamento of this.pagamentos.values()) {
          if (pagamento.status !== 'aprovado') continue;
          if (pagamento.intencao.idCampanha !== idCampanha) continue;
          const contribuinte = pagamento.intencao.contribuinte;
          if (contribuinte === null) continue;
          const mensagem = contribuinte.mensagem;
          if (typeof mensagem !== 'string' || mensagem.trim().length === 0) {
            continue;
          }
          // First contribuição-tipo item by position. Items already
          // arrive in caller-controlled position order on the entity;
          // we don't re-sort here.
          const firstContribuicaoItem = pagamento.intencao.items.find(
            (item) => item.tipo === 'contribuicao',
          );
          const idPrimeiraContribuicao =
            firstContribuicaoItem !== undefined ? firstContribuicaoItem.idContribuicao : null;
          matches.push({
            idPagamento: pagamento.id,
            contribuinteNome: contribuinte.nome,
            mensagem,
            criadoEm: pagamento.criadoEm,
            lidaEm: this.mensagemLidaEmByIdPagamento.get(pagamento.id) ?? null,
            valorContribuicaoCents:
              pagamento.intencao.composicaoValoresAggregate.totalContributionCents,
            idPrimeiraContribuicao,
          });
        }
        matches.sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime());
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
   * aperture-16wrk / 5v766 Phase A — idempotent first-write-wins.
   * Throws `PagamentoNaoEncontradoError` when the pagamento doesn't
   * exist; absence of a row to mark is a use-case bug, not a no-op.
   */
  async marcarRecadoLido(idPagamento: IdPagamento, lidaEm: Date): Promise<Date> {
    return tracer.startActiveSpan('db.pagamentos.marcarRecadoLido', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        if (!this.pagamentos.has(idPagamento)) {
          throw new PagamentoNaoEncontradoError(idPagamento);
        }
        const existing = this.mensagemLidaEmByIdPagamento.get(idPagamento);
        if (existing !== undefined) {
          span.setStatus({ code: SpanStatusCode.OK });
          return existing;
        }
        this.mensagemLidaEmByIdPagamento.set(idPagamento, lidaEm);
        span.setStatus({ code: SpanStatusCode.OK });
        return lidaEm;
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
   * aperture-16wrk / 5v766 Phase A — batch first-write-wins. Linear
   * scan over aprovado-with-mensagem rows on the campanha; flips the
   * unread ones to `lidaEm`. Already-read rows are untouched.
   */
  async marcarTodosRecadosLidos(idCampanha: IdCampanha, lidaEm: Date): Promise<number> {
    return tracer.startActiveSpan('db.pagamentos.marcarTodosRecadosLidos', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        let flipped = 0;
        for (const pagamento of this.pagamentos.values()) {
          if (pagamento.status !== 'aprovado') continue;
          if (pagamento.intencao.idCampanha !== idCampanha) continue;
          const mensagem = pagamento.intencao.contribuinte?.mensagem;
          if (typeof mensagem !== 'string' || mensagem.trim().length === 0) {
            continue;
          }
          if (this.mensagemLidaEmByIdPagamento.has(pagamento.id)) continue;
          this.mensagemLidaEmByIdPagamento.set(pagamento.id, lidaEm);
          flipped += 1;
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return flipped;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
