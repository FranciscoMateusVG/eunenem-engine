import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { IdCampanha } from '../../../domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../../domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import {
  aprovarRepasse,
  aprovarRepassePix,
  cancelarRepasse,
  criarRepasseRecebedorSolicitado,
  iniciarTransferencia,
  marcarRepasseFalhou,
  marcarRepasseNeedsManualResolution,
  marcarRepassePago,
  marcarRepasseVerificando,
  type RepasseRecebedor,
  resolverManualFalhou,
  resolverManualPago,
  reverterTransferenciaParaAprovado,
  type StatusRepasse,
} from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type { DadosRecebedorAtivo } from '../../../domain/pagamentos/financeiro/value-objects/dados-recebedor-ativo.js';
import type {
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
} from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../../errors/pagamentos/financeiro/pagamento-ja-registrado.error.js';
import { FinanceiroRepasseJaPendenteError } from '../../../errors/pagamentos/financeiro/repasse-ja-pendente.error.js';
import { FinanceiroRepasseNaoEncontradoError } from '../../../errors/pagamentos/financeiro/repasse-nao-encontrado.error.js';
import { FinanceiroRepasseStatusInvalidoError } from '../../../errors/pagamentos/financeiro/repasse-status-invalido.error.js';
import type { RecebedorRepository } from '../../arrecadacao/recebedor-repository.js';
import type { PagamentoRepository } from '../repository.js';
import type {
  LivroFinanceiroRepository,
  RepasseReconciliacaoCandidato,
  RepasseTransactionExecutor,
  RepasseTransferAttempt,
  RepasseTransferResultado,
  RepasseTransferResultadoTerminal,
} from './livro-repository.js';

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
 *
 * **aperture-s03dr.** Adds the repasse-FSM extension:
 *
 *   - `findLancamentosDisponiveisByIdCampanha` walks lançamentos +
 *     consults the (optionally-injected) `PagamentoRepository` for the
 *     parent pagamento status + balance_transaction available_on.
 *   - `solicitarRepasseTransaction` does the preflight scan, computes
 *     the amountCents SUM, INSERTs the repasse, and stamps id_repasse
 *     on the claimed lançamento set — all as one logical batch. The
 *     unique-pending-per-campanha guard is enforced by a preflight
 *     scan over existing repasses.
 *   - `aprovarRepasseTransaction` transitions the repasse + bulk-stamps
 *     `transferidoEm` on the linked lançamento set with the same
 *     timestamp.
 */
/**
 * aperture-vvh2j. In-memory mirror of the `repasse_transfer_attempts`
 * table — one row per executar pickup + one audit row per reconciliation
 * resolve / admin cancel. Fields are mutable so `fecharTentativa` can
 * close an open intent row in place (matches the postgres UPDATE ... SET
 * outcome/finished_at on the open attempt).
 */
interface RepasseTransferAttemptRecord {
  id: string;
  repasseId: IdRepasse;
  attemptNo: number;
  referencia: string | null;
  startedAt: Date;
  requestSummary: string;
  outcome: string | null;
  codigoSolicitacao: string | null;
  error: string | null;
  finishedAt: Date | null;
}

export class LivroFinanceiroRepositoryMemory implements LivroFinanceiroRepository {
  private readonly lancamentos = new Map<IdLancamentoFinanceiro, LancamentoFinanceiro>();
  private readonly repasses = new Map<IdRepasse, RepasseRecebedor>();
  private readonly repasseTransferAttempts: RepasseTransferAttemptRecord[] = [];
  private readonly repasseCandidatos: Array<
    { readonly repasseId: IdRepasse; readonly criadoEm: Date } & RepasseReconciliacaoCandidato
  > = [];

  constructor(
    private readonly recebedorRepository?: RecebedorRepository,
    private readonly pagamentoRepository?: PagamentoRepository,
  ) {}

  /**
   * Insert an attempt row, ENFORCING the same (repasse_id, attempt_no) unique
   * constraint the Postgres schema carries
   * (repasse_transfer_attempts_repasse_attempt_uniq). Without this, the memory
   * adapter's plain `push` silently accepts duplicate attempt_no rows that the
   * real database rejects with 23505 — which is exactly how the resolver/cancel
   * audit-row collision shipped green (aperture-vvh2j, GLaDOS money-flow review
   * 2026-07-16). This makes the fast unit suite faithful to that constraint.
   */
  private pushTransferAttempt(record: RepasseTransferAttemptRecord): void {
    const collision = this.repasseTransferAttempts.some(
      (a) => a.repasseId === record.repasseId && a.attemptNo === record.attemptNo,
    );
    if (collision) {
      const err = new Error(
        `duplicate key value violates unique constraint "repasse_transfer_attempts_repasse_attempt_uniq" (repasse_id=${record.repasseId}, attempt_no=${record.attemptNo})`,
      ) as Error & { code: string };
      err.code = '23505';
      throw err;
    }
    this.repasseTransferAttempts.push(record);
  }

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
    return tracer.startActiveSpan('db.financeiro_livro.lancamentos.findByIds', async (span) => {
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
    });
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

  async findVerificandoRepassesMaisVelhasQue(input: {
    readonly agora: Date;
    readonly minIdadeMinutos: number;
  }): Promise<readonly IdRepasse[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.findVerificandoOrfaos',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const cutoff = new Date(input.agora.getTime() - input.minIdadeMinutos * 60_000);
          const ids = [...this.repasses.values()]
            .filter((r) => r.status === 'verificando')
            .filter((r) => {
              // Newest verificando-transition timestamp for this repasse.
              const enteredVerificando = this.repasseTransferAttempts
                .filter((a) => a.repasseId === r.id && a.outcome === 'verificando' && a.finishedAt)
                .reduce<Date | null>(
                  (max, a) =>
                    max === null || (a.finishedAt as Date) > max ? (a.finishedAt as Date) : max,
                  null,
                );
              // No verificando attempt row → conservatively excluded (as in SQL).
              return enteredVerificando !== null && enteredVerificando < cutoff;
            })
            .map((r) => r.id);
          span.setStatus({ code: SpanStatusCode.OK });
          return ids;
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
   * aperture-riywh. Cursor-paginated admin browse. Cursor encodes the
   * (solicitadoEm-iso, id) of the last row of the previous page; we
   * include rows STRICTLY EARLIER (DESC sort) than the cursor row.
   * Plain string encoding `${ms}:${id}` — opaque to callers.
   */
  async findRepassesPaginated(input: {
    readonly statusFilter: StatusRepasse | 'all';
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<{
    readonly repasses: readonly RepasseRecebedor[];
    readonly nextCursor: string | null;
    readonly totalCount: number;
  }> {
    return tracer.startActiveSpan('db.financeiro_livro.repasses.findPaginated', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const filtered = [...this.repasses.values()].filter((r) =>
          input.statusFilter === 'all' ? true : r.status === input.statusFilter,
        );
        // Sort DESC by solicitadoEm, then by id ASC as tiebreaker.
        const sorted = filtered.slice().sort((a: RepasseRecebedor, b: RepasseRecebedor) => {
          const t = b.solicitadoEm.getTime() - a.solicitadoEm.getTime();
          return t !== 0 ? t : a.id.localeCompare(b.id);
        });

        const startIdx = input.cursor === null ? 0 : decodeCursorIndex(sorted, input.cursor);
        const page = sorted.slice(startIdx, startIdx + input.limit);
        const nextCursor =
          startIdx + input.limit < sorted.length && page.length > 0
            ? encodeCursor(page[page.length - 1] as RepasseRecebedor)
            : null;

        span.setStatus({ code: SpanStatusCode.OK });
        return { repasses: page, nextCursor, totalCount: sorted.length };
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
   * aperture-riywh. Lançamentos linked to a single repasse (drill-down).
   */
  async findLancamentosByIdRepasse(idRepasse: IdRepasse): Promise<readonly LancamentoFinanceiro[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.findByIdRepasse',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const result = [...this.lancamentos.values()]
            .filter((l) => l.idRepasse === idRepasse)
            .sort(
              (a: LancamentoFinanceiro, b: LancamentoFinanceiro) =>
                a.criadoEm.getTime() - b.criadoEm.getTime(),
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

  /**
   * aperture-s03dr. Eligible-lançamentos preflight scan.
   *
   * Mirrors the postgres query: recebedor tipo + campanha match,
   * un-transferred, un-cancelled, not-yet-swept-into-repasse, parent
   * pagamento aprovado AND available_on <= now. Without a
   * pagamentoRepository injected, the cross-port filter degrades to
   * "trust everything" — useful only for tests that pre-seed the
   * memory adapter directly without pagamentos.
   */
  async findLancamentosDisponiveisByIdCampanha(
    idCampanha: IdCampanha,
    now: Date,
  ): Promise<readonly LancamentoFinanceiro[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.findDisponiveisByIdCampanha',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const candidates = [...this.lancamentos.values()].filter(
            (l) =>
              l.tipo === 'credito_saldo_recebedor' &&
              l.idCampanha === idCampanha &&
              l.transferidoEm === null &&
              l.canceladoEm === null &&
              l.idRepasse === null,
          );

          if (!this.pagamentoRepository) {
            // Memory adapter without cross-port wiring — caller is
            // responsible for state coherence.
            span.setStatus({ code: SpanStatusCode.OK });
            return candidates;
          }

          const eligible: LancamentoFinanceiro[] = [];
          for (const l of candidates) {
            const pagamento = await this.pagamentoRepository.findById(l.idPagamento as never);
            if (!pagamento) continue;
            if (pagamento.status !== 'aprovado') continue;
            const availableOn = pagamento.intencao.balanceTransactionAvailableOn;
            if (availableOn === null || availableOn === undefined) continue;
            if (availableOn.getTime() > now.getTime()) continue;
            eligible.push(l);
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return eligible;
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

  async solicitarRepasseTransaction(input: {
    readonly idCampanha: IdCampanha;
    readonly idRepasse: IdRepasse;
    readonly solicitadoEm: Date;
    readonly now: Date;
  }): Promise<{
    readonly repasse: RepasseRecebedor;
    readonly idsLancamentosClaimados: readonly IdLancamentoFinanceiro[];
  }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.solicitarTransaction',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
        try {
          // Unique-pending-per-campanha guard.
          for (const r of this.repasses.values()) {
            if (r.idCampanha === input.idCampanha && r.status === 'solicitado') {
              throw new FinanceiroRepasseJaPendenteError(input.idCampanha);
            }
          }

          // Re-scan eligibility under the (logical) lock — same predicate
          // as findLancamentosDisponiveisByIdCampanha.
          const eligible = await this.findLancamentosDisponiveisByIdCampanha(
            input.idCampanha,
            input.now,
          );

          const amountCents = eligible.reduce((sum, l) => sum + l.amountCents, 0);

          const repasse = criarRepasseRecebedorSolicitado(
            {
              idRepasse: input.idRepasse,
              idCampanha: input.idCampanha,
              amountCents,
            },
            input.solicitadoEm,
          );

          this.repasses.set(repasse.id, repasse);
          const idsLancamentosClaimados: IdLancamentoFinanceiro[] = [];
          for (const l of eligible) {
            this.lancamentos.set(l.id, { ...l, idRepasse: repasse.id });
            idsLancamentosClaimados.push(l.id);
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return { repasse, idsLancamentosClaimados };
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

  async aprovarRepasseTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly aprovadoEm: Date;
    readonly bankTransferRef: string | null;
  }): Promise<{
    readonly repasse: RepasseRecebedor;
    readonly lancamentosAfetados: number;
  }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.aprovarTransaction',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          const existing = this.repasses.get(input.idRepasse);
          if (!existing) {
            throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
          }

          // Idempotent at the SAME terminal state.
          if (existing.status === 'aprovado') {
            if (existing.bankTransferRef === input.bankTransferRef) {
              span.setStatus({ code: SpanStatusCode.OK });
              return { repasse: existing, lancamentosAfetados: 0 };
            }
            throw new FinanceiroRepasseStatusInvalidoError(input.idRepasse, existing.status);
          }

          // Domain-layer transition (forward-only enforced inside).
          const updated = aprovarRepasse(existing, input.bankTransferRef, input.aprovadoEm);
          this.repasses.set(updated.id, updated);

          // Bulk-stamp transferidoEm on linked + un-transferred + un-
          // cancelled lançamentos.
          let lancamentosAfetados = 0;
          for (const [id, l] of this.lancamentos.entries()) {
            if (l.idRepasse !== updated.id) continue;
            if (l.transferidoEm !== null || l.canceladoEm !== null) continue;
            this.lancamentos.set(id, { ...l, transferidoEm: input.aprovadoEm });
            lancamentosAfetados += 1;
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return { repasse: updated, lancamentosAfetados };
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

  // ───────────────────────────────────────────────────────────────────
  // aperture-vvh2j — automated PIX transfer FSM (pix recebedores only).
  // ───────────────────────────────────────────────────────────────────

  async aprovarRepassePixTransaction(
    input: {
      readonly idRepasse: IdRepasse;
      readonly aprovadoEm: Date;
      readonly transferReferencia: string;
    },
    enqueueDentroDaTransacao: (executor: RepasseTransactionExecutor) => Promise<void>,
  ): Promise<{ readonly repasse: RepasseRecebedor }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.aprovarPixTransaction',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          const existing = this.repasses.get(input.idRepasse);
          if (!existing) {
            throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
          }

          // Idempotent at the SAME aprovado state — only if the stable
          // referencia matches. A different referencia is a caller bug.
          if (existing.status === 'aprovado') {
            if (existing.transferReferencia === input.transferReferencia) {
              span.setStatus({ code: SpanStatusCode.OK });
              return { repasse: existing };
            }
            throw new FinanceiroRepasseStatusInvalidoError(input.idRepasse, existing.status);
          }

          if (existing.status !== 'solicitado') {
            throw new FinanceiroRepasseStatusInvalidoError(input.idRepasse, existing.status);
          }

          // Domain pix approval — binds the stable transferReferencia.
          // Does NOT stamp transferido_em (moved to `pago`, aperture-vvh2j).
          const updated = aprovarRepassePix(existing, input.transferReferencia, input.aprovadoEm);
          this.repasses.set(updated.id, updated);

          // Memory has no real transaction; we still invoke the enqueue
          // callback with a stub executor so tests can assert the enqueue
          // was attempted inside the (logical) transaction.
          await enqueueDentroDaTransacao({
            executeSql: async () => ({ rows: [] }),
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return { repasse: updated };
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

  async iniciarTransferenciaTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly requestSummary: string;
    readonly agora: Date;
  }): Promise<{
    readonly repasse: RepasseRecebedor;
    readonly attemptId: string;
    readonly attemptNo: number;
    readonly acao: 'prosseguir' | 'reconciliar' | 'concluido';
  }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.iniciarTransferenciaTransaction',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          const existing = this.repasses.get(input.idRepasse);
          if (!existing) {
            throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
          }

          // Already resolved / being reconciled → re-delivered job no-ops.
          if (
            existing.status === 'pago' ||
            existing.status === 'cancelado' ||
            existing.status === 'verificando'
          ) {
            span.setStatus({ code: SpanStatusCode.OK });
            return {
              repasse: existing,
              attemptId: '',
              attemptNo: existing.transferAttempts,
              acao: 'concluido' as const,
            };
          }

          // Crash re-delivery: a pagarPix MAY have gone out. Hand back the
          // still-open attempt so the handler diverts to verificando.
          if (existing.status === 'transferindo') {
            const open = this.repasseTransferAttempts
              .filter(
                (a) => a.repasseId === existing.id && a.attemptNo === existing.transferAttempts,
              )
              .at(-1);
            span.setStatus({ code: SpanStatusCode.OK });
            return {
              repasse: existing,
              attemptId: open?.id ?? '',
              attemptNo: existing.transferAttempts,
              acao: 'reconciliar' as const,
            };
          }

          // Fresh claim: aprovado|falhou → transferindo, ++attempts,
          // clears last_transfer_error (reuses the stable referencia).
          const updated = iniciarTransferencia(existing);
          this.repasses.set(updated.id, updated);

          // Committed intent row (open attempt) — the crash-recovery signal.
          const attemptId = randomUUID();
          this.pushTransferAttempt({
            id: attemptId,
            repasseId: updated.id,
            attemptNo: updated.transferAttempts,
            referencia: updated.transferReferencia,
            startedAt: input.agora,
            requestSummary: input.requestSummary,
            outcome: null,
            codigoSolicitacao: null,
            error: null,
            finishedAt: null,
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return {
            repasse: updated,
            attemptId,
            attemptNo: updated.transferAttempts,
            acao: 'prosseguir' as const,
          };
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

  async finalizarTentativaTransferencia(input: {
    readonly idRepasse: IdRepasse;
    readonly attemptId: string;
    readonly resultado: RepasseTransferResultado;
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.finalizarTentativaTransferencia',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          const existing = this.repasses.get(input.idRepasse);
          if (!existing) {
            throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
          }

          const resultado = input.resultado;
          let updated: RepasseRecebedor;
          switch (resultado.tipo) {
            case 'pago': {
              updated = marcarRepassePago(existing, resultado.codigoSolicitacao);
              this.repasses.set(updated.id, updated);
              // Single debit point — stamp transferido_em on the linked,
              // un-transferred, un-cancelled lançamentos.
              this.stampTransferidoEm(updated.id, input.agora);
              this.fecharTentativa(input.attemptId, {
                outcome: 'pago',
                codigoSolicitacao: resultado.codigoSolicitacao,
                finishedAt: input.agora,
              });
              break;
            }
            case 'verificando': {
              updated = marcarRepasseVerificando(existing, resultado.codigoSolicitacao);
              this.repasses.set(updated.id, updated);
              // No stamp — payment outcome is still unknown.
              this.fecharTentativa(input.attemptId, {
                outcome: 'verificando',
                codigoSolicitacao: resultado.codigoSolicitacao,
                finishedAt: input.agora,
              });
              break;
            }
            case 'falhou': {
              updated = marcarRepasseFalhou(existing, resultado.erro);
              this.repasses.set(updated.id, updated);
              // No stamp — confirmed no money moved.
              this.fecharTentativa(input.attemptId, {
                outcome: 'falhou',
                error: resultado.erro,
                finishedAt: input.agora,
              });
              break;
            }
            case 'transitorio': {
              // Definitely no payment — revert so the retry is a clean claim.
              updated = reverterTransferenciaParaAprovado(existing);
              this.repasses.set(updated.id, updated);
              this.fecharTentativa(input.attemptId, {
                outcome: 'transitorio',
                error: resultado.erro,
                finishedAt: input.agora,
              });
              break;
            }
            default: {
              const _exhaustive: never = resultado;
              throw new Error(`resultado.tipo inesperado: ${JSON.stringify(_exhaustive)}`);
            }
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return { repasse: updated };
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

  async resolverVerificacaoTransferencia(input: {
    readonly idRepasse: IdRepasse;
    readonly resultado: RepasseTransferResultadoTerminal;
    readonly reconciliacaoResumo: string;
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.resolverVerificacaoTransferencia',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          const existing = this.repasses.get(input.idRepasse);
          if (!existing) {
            throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
          }

          // Idempotent — only a repasse still in `verificando` is resolvable.
          if (existing.status !== 'verificando') {
            span.setStatus({ code: SpanStatusCode.OK });
            return { repasse: existing };
          }

          const resultado = input.resultado;
          let updated: RepasseRecebedor;
          switch (resultado.tipo) {
            case 'pago': {
              updated = marcarRepassePago(existing, resultado.codigoSolicitacao);
              this.repasses.set(updated.id, updated);
              this.stampTransferidoEm(updated.id, input.agora);
              break;
            }
            case 'falhou': {
              updated = marcarRepasseFalhou(existing, resultado.erro);
              this.repasses.set(updated.id, updated);
              break;
            }
            default: {
              const _exhaustive: never = resultado;
              throw new Error(`resultado.tipo inesperado: ${JSON.stringify(_exhaustive)}`);
            }
          }

          // Close out the CURRENT attempt row (attempt_no = transferAttempts)
          // with its reconciled terminal outcome — an UPDATE, mirroring the
          // Postgres adapter. Inserting a fresh row that reuses attempt_no
          // would collide with the intent row under the unique constraint.
          const codigo = resultado.tipo === 'pago' ? resultado.codigoSolicitacao : null;
          const erro = resultado.tipo === 'falhou' ? resultado.erro : null;
          const attemptRow = this.repasseTransferAttempts.find(
            (a) => a.repasseId === updated.id && a.attemptNo === existing.transferAttempts,
          );
          if (attemptRow) {
            attemptRow.outcome = resultado.tipo;
            attemptRow.codigoSolicitacao = codigo ?? attemptRow.codigoSolicitacao;
            attemptRow.error = erro;
            attemptRow.finishedAt = input.agora;
            attemptRow.requestSummary = `${attemptRow.requestSummary} | reconciliacao: ${input.reconciliacaoResumo}`;
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return { repasse: updated };
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

  async cancelarRepasseTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly canceladoPor: string;
    readonly agora: Date;
  }): Promise<{
    readonly repasse: RepasseRecebedor;
    readonly lancamentosLiberados: number;
  }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.cancelarTransaction',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          const existing = this.repasses.get(input.idRepasse);
          if (!existing) {
            throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
          }

          // Domain transition falhou → cancelado (defense-in-depth guard).
          const updated = cancelarRepasse(existing);
          this.repasses.set(updated.id, updated);

          // The ONLY claim-release path: clear id_repasse on linked,
          // un-transferred lançamentos so funds return to disponivel.
          let lancamentosLiberados = 0;
          for (const [id, l] of this.lancamentos.entries()) {
            if (l.idRepasse !== updated.id) continue;
            if (l.transferidoEm !== null) continue;
            this.lancamentos.set(id, { ...l, idRepasse: null });
            lancamentosLiberados += 1;
          }

          // Audit row carrying the acting admin. Cancel is not a payment
          // attempt — number it MAX+1 so it never collides with the last
          // intent row (collision-free: `cancelado` is terminal). Mirrors the
          // Postgres MAX(attempt_no)+1 insert.
          const maxAttemptNo = this.repasseTransferAttempts
            .filter((a) => a.repasseId === updated.id)
            .reduce((max, a) => Math.max(max, a.attemptNo), 0);
          this.pushTransferAttempt({
            id: randomUUID(),
            repasseId: updated.id,
            attemptNo: maxAttemptNo + 1,
            referencia: updated.transferReferencia ?? '',
            startedAt: input.agora,
            requestSummary: `cancelado_por:${input.canceladoPor}`,
            outcome: 'cancelado',
            codigoSolicitacao: null,
            error: null,
            finishedAt: input.agora,
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return { repasse: updated, lancamentosLiberados };
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

  private nextAttemptNo(idRepasse: IdRepasse): number {
    return (
      this.repasseTransferAttempts
        .filter((a) => a.repasseId === idRepasse)
        .reduce((max, a) => Math.max(max, a.attemptNo), 0) + 1
    );
  }

  async flagNeedsManualResolutionTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly candidatos: readonly RepasseReconciliacaoCandidato[];
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    const existing = this.repasses.get(input.idRepasse);
    if (!existing) {
      throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
    }
    if (existing.status !== 'verificando') {
      return { repasse: existing };
    }
    const updated = marcarRepasseNeedsManualResolution(existing);
    this.repasses.set(updated.id, updated);
    for (const c of input.candidatos) {
      const dup = this.repasseCandidatos.some(
        (x) => x.repasseId === updated.id && x.codigoSolicitacao === c.codigoSolicitacao,
      );
      if (!dup) {
        this.repasseCandidatos.push({ repasseId: updated.id, criadoEm: input.agora, ...c });
      }
    }
    return { repasse: updated };
  }

  async resolverManualPagoTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly interCodigoSolicitacao: string;
    readonly resolvidoPor: string;
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    const existing = this.repasses.get(input.idRepasse);
    if (!existing) {
      throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
    }
    if (existing.status !== 'verificando' || !existing.needsManualResolution) {
      return { repasse: existing };
    }
    const updated = resolverManualPago(existing, input.interCodigoSolicitacao);
    this.repasses.set(updated.id, updated);
    this.stampTransferidoEm(updated.id, input.agora);
    this.pushTransferAttempt({
      id: randomUUID(),
      repasseId: updated.id,
      attemptNo: this.nextAttemptNo(updated.id),
      referencia: updated.transferReferencia ?? '',
      startedAt: input.agora,
      requestSummary: `resolucao_manual_pago_por:${input.resolvidoPor}`,
      outcome: 'pago',
      codigoSolicitacao: input.interCodigoSolicitacao,
      error: null,
      finishedAt: input.agora,
    });
    return { repasse: updated };
  }

  async resolverManualFalhouTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly erro: string;
    readonly resolvidoPor: string;
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    const existing = this.repasses.get(input.idRepasse);
    if (!existing) {
      throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
    }
    if (existing.status !== 'verificando' || !existing.needsManualResolution) {
      return { repasse: existing };
    }
    const updated = resolverManualFalhou(existing, input.erro);
    this.repasses.set(updated.id, updated);
    this.pushTransferAttempt({
      id: randomUUID(),
      repasseId: updated.id,
      attemptNo: this.nextAttemptNo(updated.id),
      referencia: updated.transferReferencia ?? '',
      startedAt: input.agora,
      requestSummary: `resolucao_manual_falhou_por:${input.resolvidoPor}`,
      outcome: 'falhou',
      codigoSolicitacao: null,
      error: input.erro,
      finishedAt: input.agora,
    });
    return { repasse: updated };
  }

  async findCandidatosByRepasseId(
    idRepasse: IdRepasse,
  ): Promise<readonly RepasseReconciliacaoCandidato[]> {
    return this.repasseCandidatos
      .filter((c) => c.repasseId === idRepasse)
      .sort((a, b) => a.criadoEm.getTime() - b.criadoEm.getTime())
      .map((c) => ({
        codigoSolicitacao: c.codigoSolicitacao,
        valorCents: c.valorCents,
        dataMovimento: c.dataMovimento,
        chaveMascarada: c.chaveMascarada,
        descricaoPix: c.descricaoPix,
      }));
  }

  async findTransferAttemptsByRepasseId(
    idRepasse: IdRepasse,
  ): Promise<readonly RepasseTransferAttempt[]> {
    const attempts = this.repasseTransferAttempts
      .filter((a) => a.repasseId === idRepasse)
      .sort((a, b) => a.attemptNo - b.attemptNo || a.startedAt.getTime() - b.startedAt.getTime())
      .map(
        (a): RepasseTransferAttempt => ({
          id: a.id,
          repasseId: a.repasseId,
          attemptNo: a.attemptNo,
          referencia: a.referencia ?? '',
          startedAt: a.startedAt,
          finishedAt: a.finishedAt,
          requestSummary: a.requestSummary,
          outcome: a.outcome,
          codigoSolicitacao: a.codigoSolicitacao,
          error: a.error,
        }),
      );
    return attempts;
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

  /**
   * aperture-vvh2j. Stamp `transferidoEm` on every lançamento linked to
   * the repasse that is not already transferred or cancelled — the single
   * debit point (mirrors the postgres WHERE id_repasse = X AND
   * transferido_em IS NULL AND cancelado_em IS NULL). Replaces the row
   * object since lançamentos are readonly (same idiom as
   * `marcarLancamentosComoTransferidos`).
   */
  private stampTransferidoEm(idRepasse: IdRepasse, transferidoEm: Date): void {
    for (const [id, l] of this.lancamentos.entries()) {
      if (l.idRepasse !== idRepasse) continue;
      if (l.transferidoEm !== null || l.canceladoEm !== null) continue;
      this.lancamentos.set(id, { ...l, transferidoEm });
    }
  }

  /**
   * aperture-vvh2j. Close an open intent attempt row in place. No-op if
   * the attempt id is unknown (defensive — matches the postgres UPDATE
   * touching zero rows).
   */
  private fecharTentativa(
    attemptId: string,
    patch: {
      readonly outcome: string;
      readonly finishedAt: Date;
      readonly codigoSolicitacao?: string | null;
      readonly error?: string | null;
    },
  ): void {
    const attempt = this.repasseTransferAttempts.find((a) => a.id === attemptId);
    if (!attempt) return;
    attempt.outcome = patch.outcome;
    attempt.finishedAt = patch.finishedAt;
    if (patch.codigoSolicitacao !== undefined) {
      attempt.codigoSolicitacao = patch.codigoSolicitacao;
    }
    if (patch.error !== undefined) {
      attempt.error = patch.error;
    }
  }
}

/**
 * Encode a repasse cursor: `${solicitadoEm-ms}:${id}`.
 * Opaque to callers — adapter-internal format.
 */
function encodeCursor(r: RepasseRecebedor): string {
  return `${r.solicitadoEm.getTime()}:${r.id}`;
}

/**
 * Decode the cursor: return the index of the FIRST row whose
 * (solicitadoEm, id) is STRICTLY LESS THAN the cursor's tuple under the
 * DESC sort. If the cursor references a row no longer in the page (e.g.
 * because filter changed between pages), returns sorted.length (empty
 * page).
 */
function decodeCursorIndex(sorted: readonly RepasseRecebedor[], cursor: string): number {
  const colonIdx = cursor.indexOf(':');
  if (colonIdx === -1) return sorted.length;
  const cursorMs = Number(cursor.slice(0, colonIdx));
  const cursorId = cursor.slice(colonIdx + 1);
  for (let i = 0; i < sorted.length; i += 1) {
    const r = sorted[i] as RepasseRecebedor;
    const rMs = r.solicitadoEm.getTime();
    if (rMs < cursorMs) return i;
    if (rMs === cursorMs && r.id > cursorId) return i;
  }
  return sorted.length;
}
