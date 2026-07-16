import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { CompiledQuery, sql } from 'kysely';
import type { IdCampanha } from '../../../domain/arrecadacao/value-objects/ids.js';
import {
  type LancamentoFinanceiro,
  LancamentoFinanceiroSchema,
} from '../../../domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
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
  RepasseRecebedorSchema,
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
import type { Database } from '../../database.js';
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
  'db.system': 'postgresql',
  'db.collection.name': 'financeiro_livro',
} as const;

/**
 * Constraint name from migration 20260609_023_lancamentos_financeiros_per_item
 * (Plan 0016 Phase 2 — UNIQUE was dropped from `(id_pagamento, tipo)` and
 * re-added on `(id_item_pagamento, tipo)`). Surfaces
 * `FinanceiroPagamentoJaRegistradoError` on retry (Stripe webhook
 * idempotency relies on the typed error to short-circuit).
 *
 * The new constraint fires per-item-per-tipo. Any retry of the same
 * pagamento re-emits lançamentos for the same items, so the 23505 path is
 * functionally equivalent — translating it to the same typed error
 * preserves the pre-0016 retry-shape semantics.
 */
const UNIQUE_ITEM_TIPO = 'lancamentos_financeiros_id_item_pagamento_tipo_uniq';
/**
 * aperture-s03dr / migration 021. Unique partial index name used to
 * surface FinanceiroRepasseJaPendenteError on the concurrent-solicitação
 * race (two requests for the same campanha; one wins, one hits 23505).
 */
const UNIQUE_REPASSE_PENDENTE_POR_CAMPANHA = 'repasses_um_solicitado_por_campanha';

interface PostgresError {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pgErr = error as PostgresError;
  if (pgErr.code !== '23505') return false;
  if (pgErr.constraint === constraint) return true;
  if (pgErr.detail?.includes(constraint)) return true;
  return false;
}

/**
 * Plan 0015 / migration 019: status + matura_em dropped; transferido_em +
 * cancelado_em added (both nullable timestamps).
 * aperture-s03dr / migration 021: id_repasse added (nullable).
 * Plan 0016 Phase 2 / migration 023: id_item_pagamento added (NOT NULL
 * FK to intencao_items.id; one lançamento per (item, tipo) pair).
 */
type LancamentoRow = {
  id: string;
  id_pagamento: string;
  id_item_pagamento: string;
  id_contribuicao: string;
  id_campanha: string | null;
  tipo: string;
  amount_cents: number;
  criado_em: Date;
  transferido_em: Date | null;
  cancelado_em: Date | null;
  id_repasse: string | null;
};

/**
 * aperture-s03dr / migration 021: aprovado_em + bank_transfer_ref added;
 * status CHECK now includes 'aprovado'.
 */
type RepasseRow = {
  id: string;
  id_campanha: string;
  amount_cents: number;
  status: string;
  solicitado_em: Date;
  aprovado_em: Date | null;
  bank_transfer_ref: string | null;
  // aperture-vvh2j — automated PIX transfer bookkeeping.
  transfer_referencia: string | null;
  inter_codigo_solicitacao: string | null;
  transfer_attempts: number;
  last_transfer_error: string | null;
  // aperture-477nz — manual reconciliation flag.
  needs_manual_resolution: boolean;
};

/**
 * PostgreSQL adapter for `LivroFinanceiroRepository`.
 *
 * Plan 0015 (aperture-ucgok) reshape:
 *   - row mapper drops status/matura_em, picks up transferido_em + cancelado_em
 *   - new mutation: `marcarLancamentosComoTransferidos` (admin batch action)
 *   - new mutation: `marcarLancamentosComoCanceladosPorPagamento` (estorno cascade)
 *   - new query: `hasLancamentosTransferidos` (estorno 409 gate)
 *   - removed: `findPendentesMaturos`, `marcarComoDisponivel` (FSM-based methods gone)
 */
export class LivroFinanceiroRepositoryPostgres implements LivroFinanceiroRepository {
  constructor(
    private readonly db: Database,
    private readonly recebedorRepository?: RecebedorRepository,
  ) {}

  async saveLancamentos(lancamentos: readonly LancamentoFinanceiro[]): Promise<void> {
    return tracer.startActiveSpan('db.financeiro_livro.lancamentos.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        if (lancamentos.length === 0) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }

        const rows = lancamentos.map(rowFromLancamento);

        // biome-ignore lint/suspicious/noExplicitAny: row shape uses Record<string, unknown> for the heterogeneous date+null inserts; the Kysely DB type doesn't narrow that cleanly.
        await (this.db as any).insertInto('lancamentos_financeiros').values(rows).execute();

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        if (isUniqueViolation(error, UNIQUE_ITEM_TIPO)) {
          // Surface the typed error for the first conflicting idPagamento
          // in the batch — matches memory adapter's preflight loop order.
          const first = lancamentos[0];
          if (first) {
            const typed = new FinanceiroPagamentoJaRegistradoError(first.idPagamento);
            span.recordException(typed);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw typed;
          }
        }
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
          // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
          const rows = (await (this.db as any)
            .selectFrom('lancamentos_financeiros')
            .selectAll()
            .where('id_pagamento', '=', idPagamento)
            .execute()) as LancamentoRow[];

          const result = rows.map(lancamentoFromRow);
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
        // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
        const rows = (await (this.db as any)
          .selectFrom('lancamentos_financeiros')
          .selectAll()
          .where('id', 'in', [...ids])
          .execute()) as LancamentoRow[];
        const result = rows.map(lancamentoFromRow);
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
          // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
          const rows = (await (this.db as any)
            .selectFrom('lancamentos_financeiros')
            .selectAll()
            .where('id_campanha', '=', idCampanha)
            .execute()) as LancamentoRow[];

          const result = rows.map(lancamentoFromRow);
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
          // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
          const rows = (await (this.db as any)
            .selectFrom('lancamentos_financeiros')
            .selectAll()
            .where('tipo', '=', 'credito_receita_plataforma')
            .execute()) as LancamentoRow[];

          const result = rows.map(lancamentoFromRow);
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
          if (idsLancamentos.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK });
            return;
          }
          // Idempotent at the WHERE: rows already transferred OR cancelled
          // are silently skipped. The UPDATE matches only the
          // pre-transfer subset of the input ids.
          await sql`
            UPDATE lancamentos_financeiros
              SET transferido_em = ${transferidoEm}
              WHERE id = ANY(${[...idsLancamentos]}::uuid[])
                AND transferido_em IS NULL
                AND cancelado_em IS NULL
          `.execute(this.db);
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
          // Estorno cascade: only the not-yet-transferred subset gets
          // canceladoEm stamped. Already-cancelled rows are silently
          // skipped (idempotent). Already-transferred rows are NEVER
          // touched here — the upstream estornar-pagamento use-case
          // enforces the 409 pre-transfer gate, so reaching this method
          // with any transferred row would be a bug; the WHERE clause
          // is defense-in-depth.
          await sql`
            UPDATE lancamentos_financeiros
              SET cancelado_em = ${canceladoEm}
              WHERE id_pagamento = ${idPagamento}
                AND cancelado_em IS NULL
                AND transferido_em IS NULL
          `.execute(this.db);
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
          // Hits the partial index
          // `lancamentos_transferidos_por_pagamento_idx ON (id_pagamento)
          // WHERE transferido_em IS NOT NULL` (migration 019) — a
          // microsecond probe.
          // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
          const row = await (this.db as any)
            .selectFrom('lancamentos_financeiros')
            .select((eb: any) => eb.fn.countAll().as('cnt'))
            .where('id_pagamento', '=', idPagamento)
            .where('transferido_em', 'is not', null)
            .executeTakeFirstOrThrow();
          const cnt = Number(row.cnt);
          span.setStatus({ code: SpanStatusCode.OK });
          return cnt > 0;
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
        // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
        await (this.db as any)
          .insertInto('repasses_recebedor')
          .values(rowFromRepasse(repasse))
          .execute();
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
        // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
        const row = (await (this.db as any)
          .selectFrom('repasses_recebedor')
          .selectAll()
          .where('id', '=', idRepasse)
          .executeTakeFirst()) as RepasseRow | undefined;

        const result = row ? repasseFromRow(row) : undefined;
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
        // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
        const rows = (await (this.db as any)
          .selectFrom('repasses_recebedor')
          .selectAll()
          .where('id_campanha', '=', idCampanha)
          .execute()) as RepasseRow[];

        const result = rows.map(repasseFromRow);
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
          // "Entered verificando" = the newest repasse_transfer_attempts row
          // with outcome='verificando' for this repasse. A row whose most-recent
          // verificando transition is older than the cutoff is a candidate. A
          // repasse with no such attempt row (should never happen) yields NULL
          // and is conservatively excluded (we never sweep what we can't age).
          const result = await sql<{ id: string }>`
            SELECT r.id
              FROM repasses_recebedor r
              WHERE r.status = 'verificando'
                AND (
                  SELECT MAX(a.finished_at)
                    FROM repasse_transfer_attempts a
                    WHERE a.repasse_id = r.id AND a.outcome = 'verificando'
                ) < ${cutoff}
          `.execute(this.db);
          const ids = result.rows.map((row) => row.id as IdRepasse);
          span.setAttribute('financeiro.repasse.orfaos_encontrados', ids.length);
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
   * aperture-riywh. Admin-facing cursor-paginated browse. Cursor
   * encodes `(solicitadoEm-ms):(id)` for stable DESC sort.
   *
   * Sort order: (solicitadoEm DESC, id ASC) — DESC on the timestamp
   * shows the freshest requests first; the id ASC tiebreaker is for
   * deterministic ordering across equal timestamps. The cursor reads:
   * "give me rows STRICTLY EARLIER than (cursorMs, cursorId) in the
   * DESC sense."
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
        // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
        let countQuery = (this.db as any).selectFrom('repasses_recebedor');
        if (input.statusFilter !== 'all') {
          countQuery = countQuery.where('status', '=', input.statusFilter);
        }
        const totalRow = await countQuery
          // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
          .select((eb: any) => eb.fn.countAll().as('cnt'))
          .executeTakeFirstOrThrow();
        const totalCount = Number(totalRow.cnt);

        // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
        let pageQuery = (this.db as any).selectFrom('repasses_recebedor').selectAll();
        if (input.statusFilter !== 'all') {
          pageQuery = pageQuery.where('status', '=', input.statusFilter);
        }
        if (input.cursor !== null) {
          const colonIdx = input.cursor.indexOf(':');
          if (colonIdx !== -1) {
            const cursorMs = Number(input.cursor.slice(0, colonIdx));
            const cursorId = input.cursor.slice(colonIdx + 1);
            const cursorDate = new Date(cursorMs);
            pageQuery = pageQuery.where(({ eb, or, and }: any) =>
              or([
                eb('solicitado_em', '<', cursorDate),
                and([eb('solicitado_em', '=', cursorDate), eb('id', '>', cursorId)]),
              ]),
            );
          }
        }
        const rows = (await pageQuery
          .orderBy('solicitado_em', 'desc')
          .orderBy('id', 'asc')
          .limit(input.limit + 1)
          .execute()) as RepasseRow[];

        const hasMore = rows.length > input.limit;
        const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
        const repasses = pageRows.map(repasseFromRow);
        const last = pageRows[pageRows.length - 1];
        const nextCursor =
          hasMore && last !== undefined ? `${last.solicitado_em.getTime()}:${last.id}` : null;

        span.setStatus({ code: SpanStatusCode.OK });
        return { repasses, nextCursor, totalCount };
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
   * Uses the partial index `lancamentos_financeiros_id_repasse_idx`
   * (migration 021).
   */
  async findLancamentosByIdRepasse(idRepasse: IdRepasse): Promise<readonly LancamentoFinanceiro[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.findByIdRepasse',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
          const rows = (await (this.db as any)
            .selectFrom('lancamentos_financeiros')
            .selectAll()
            .where('id_repasse', '=', idRepasse)
            .orderBy('criado_em', 'asc')
            .execute()) as LancamentoRow[];

          const result = rows.map(lancamentoFromRow);
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
   * aperture-s03dr. Eligible-lançamentos JOIN — single query, single
   * indexed scan on (id_campanha, transferido_em IS NULL ...). Read-only;
   * does NOT lock rows. The atomic sweep happens inside
   * `solicitarRepasseTransaction` (which re-runs the same predicate
   * under SELECT FOR UPDATE).
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
          const rows = (await sql<LancamentoRow>`
            SELECT l.*
              FROM lancamentos_financeiros l
              INNER JOIN pagamentos p ON p.id = l.id_pagamento
              WHERE l.id_campanha = ${idCampanha}
                AND l.tipo = 'credito_saldo_recebedor'
                AND l.transferido_em IS NULL
                AND l.cancelado_em IS NULL
                AND l.id_repasse IS NULL
                AND p.status = 'aprovado'
                AND p.intencao_balance_transaction_available_on IS NOT NULL
                AND p.intencao_balance_transaction_available_on <= ${now}
          `.execute(this.db)) as unknown as { rows: LancamentoRow[] };

          const result = rows.rows.map(lancamentoFromRow);
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
   * aperture-s03dr. Atomic solicitação: SELECT FOR UPDATE the eligible
   * lançamento set, compute the amountCents SUM, INSERT the repasse,
   * UPDATE lançamentos SET id_repasse — all inside one transaction. The
   * unique partial index serializes concurrent solicitações on the same
   * campanha; the 23505 catch translates to FinanceiroRepasseJaPendenteError.
   */
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
          // biome-ignore lint/suspicious/noExplicitAny: Kysely tx type narrowing isn't worth chasing for the heterogeneous mix of sql`` + insertInto here.
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            // 1. SELECT FOR UPDATE on the eligible set. The lock here +
            //    the unique partial index on (id_campanha) WHERE
            //    status='solicitado' jointly serialize concurrent
            //    solicitações on the same campanha.
            const lockedRows = (await sql<LancamentoRow>`
              SELECT l.*
                FROM lancamentos_financeiros l
                INNER JOIN pagamentos p ON p.id = l.id_pagamento
                WHERE l.id_campanha = ${input.idCampanha}
                  AND l.tipo = 'credito_saldo_recebedor'
                  AND l.transferido_em IS NULL
                  AND l.cancelado_em IS NULL
                  AND l.id_repasse IS NULL
                  AND p.status = 'aprovado'
                  AND p.intencao_balance_transaction_available_on IS NOT NULL
                  AND p.intencao_balance_transaction_available_on <= ${input.now}
                FOR UPDATE OF l
            `.execute(tx)) as unknown as { rows: LancamentoRow[] };

            const claimed = lockedRows.rows.map(lancamentoFromRow);
            const amountCents = claimed.reduce((sum, l) => sum + l.amountCents, 0);

            // 2. Build + INSERT the repasse.
            const repasse = criarRepasseRecebedorSolicitado(
              {
                idRepasse: input.idRepasse,
                idCampanha: input.idCampanha,
                amountCents,
              },
              input.solicitadoEm,
            );

            await tx.insertInto('repasses_recebedor').values(rowFromRepasse(repasse)).execute();

            // 3. Stamp id_repasse on the claimed rows.
            const idsLancamentosClaimados = claimed.map((l) => l.id);
            if (idsLancamentosClaimados.length > 0) {
              await sql`
                UPDATE lancamentos_financeiros
                  SET id_repasse = ${repasse.id}
                  WHERE id = ANY(${[...idsLancamentosClaimados]}::uuid[])
              `.execute(tx);
            }

            return { repasse, idsLancamentosClaimados };
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          // 23505 on the unique partial index → FinanceiroRepasseJaPendenteError.
          if (isUniqueViolation(error, UNIQUE_REPASSE_PENDENTE_POR_CAMPANHA)) {
            const typed = new FinanceiroRepasseJaPendenteError(input.idCampanha);
            span.recordException(typed);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw typed;
          }
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
   * aperture-s03dr. Atomic admin approval: SELECT FOR UPDATE the
   * repasse, gate on status='solicitado' (or idempotent same-state
   * short-circuit), UPDATE status + aprovado_em + bank_transfer_ref,
   * UPDATE linked + un-transferred lançamentos SET transferido_em.
   */
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
          // biome-ignore lint/suspicious/noExplicitAny: see solicitarRepasseTransaction
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            // 1. SELECT FOR UPDATE the target repasse.
            const lockedRows = (await sql<RepasseRow>`
              SELECT * FROM repasses_recebedor
                WHERE id = ${input.idRepasse}
                FOR UPDATE
            `.execute(tx)) as unknown as { rows: RepasseRow[] };

            const existing = lockedRows.rows[0];
            if (!existing) {
              throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
            }
            const existingRepasse = repasseFromRow(existing);

            // Idempotency: same terminal state + same audit value → no-op.
            if (existingRepasse.status === 'aprovado') {
              if (existingRepasse.bankTransferRef === input.bankTransferRef) {
                return { repasse: existingRepasse, lancamentosAfetados: 0 };
              }
              throw new FinanceiroRepasseStatusInvalidoError(
                input.idRepasse,
                existingRepasse.status,
              );
            }

            // 2. Domain-layer transition (forward-only).
            const updated = aprovarRepasse(
              existingRepasse,
              input.bankTransferRef,
              input.aprovadoEm,
            );

            // 3. UPDATE the repasse.
            await sql`
              UPDATE repasses_recebedor
                SET status = ${updated.status},
                    aprovado_em = ${updated.aprovadoEm},
                    bank_transfer_ref = ${updated.bankTransferRef}
                WHERE id = ${updated.id}
            `.execute(tx);

            // 4. Bulk-stamp transferidoEm on linked + un-transferred +
            //    un-cancelled lançamentos.
            const updateResult = await sql`
              UPDATE lancamentos_financeiros
                SET transferido_em = ${input.aprovadoEm}
                WHERE id_repasse = ${updated.id}
                  AND transferido_em IS NULL
                  AND cancelado_em IS NULL
            `.execute(tx);

            const lancamentosAfetados = Number(updateResult.numAffectedRows ?? 0n);

            return { repasse: updated, lancamentosAfetados };
          });

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

  // ───────────────────────────────────────────────────────────────────
  // aperture-vvh2j — automated PIX transfer FSM. transferido_em is stamped
  // ONLY at `pago` (§10.1) and id_repasse is cleared ONLY at cancel.
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
          // biome-ignore lint/suspicious/noExplicitAny: see aprovarRepasseTransaction
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            const lockedRows = (await sql<RepasseRow>`
              SELECT * FROM repasses_recebedor WHERE id = ${input.idRepasse} FOR UPDATE
            `.execute(tx)) as unknown as { rows: RepasseRow[] };
            const existing = lockedRows.rows[0];
            if (!existing) {
              throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
            }
            const existingRepasse = repasseFromRow(existing);

            // Idempotency: already aprovado with the SAME stable reference →
            // the job was already enqueued atomically; no-op, do NOT re-enqueue.
            if (existingRepasse.status === 'aprovado') {
              if (existingRepasse.transferReferencia === input.transferReferencia) {
                return { repasse: existingRepasse };
              }
              throw new FinanceiroRepasseStatusInvalidoError(
                input.idRepasse,
                existingRepasse.status,
              );
            }

            const updated = aprovarRepassePix(
              existingRepasse,
              input.transferReferencia,
              input.aprovadoEm,
            );

            // NB: no transferido_em stamp here — the debit books at `pago`.
            await sql`
              UPDATE repasses_recebedor
                SET status = ${updated.status},
                    aprovado_em = ${updated.aprovadoEm},
                    transfer_referencia = ${updated.transferReferencia}
                WHERE id = ${updated.id}
            `.execute(tx);

            // Transactional enqueue — the job row rides THIS transaction, so
            // the approval and the job's existence commit (or roll back) atomically.
            await enqueueDentroDaTransacao(buildRepasseExecutor(tx));

            return { repasse: updated };
          });
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
      'db.financeiro_livro.repasses.iniciarTransferencia',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          // biome-ignore lint/suspicious/noExplicitAny: see aprovarRepasseTransaction
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            const lockedRows = (await sql<RepasseRow>`
              SELECT * FROM repasses_recebedor WHERE id = ${input.idRepasse} FOR UPDATE
            `.execute(tx)) as unknown as { rows: RepasseRow[] };
            const existing = lockedRows.rows[0];
            if (!existing) {
              throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
            }
            const existingRepasse = repasseFromRow(existing);

            // Already resolved (pago/cancelado) or being reconciled
            // (verificando) → the re-delivered job has nothing to do.
            if (
              existingRepasse.status === 'pago' ||
              existingRepasse.status === 'cancelado' ||
              existingRepasse.status === 'verificando'
            ) {
              return {
                repasse: existingRepasse,
                attemptId: '',
                attemptNo: existingRepasse.transferAttempts,
                acao: 'concluido' as const,
              };
            }

            // Crash re-delivery: a pagarPix MAY have gone out. Do NOT open a
            // new attempt; hand the still-open attempt back so the handler
            // diverts to verificando instead of calling pagarPix again.
            if (existingRepasse.status === 'transferindo') {
              const openAttempt = (await sql<{ id: string }>`
                SELECT id FROM repasse_transfer_attempts
                  WHERE repasse_id = ${existingRepasse.id}
                    AND attempt_no = ${existingRepasse.transferAttempts}
                  ORDER BY started_at DESC LIMIT 1
              `.execute(tx)) as unknown as { rows: { id: string }[] };
              return {
                repasse: existingRepasse,
                attemptId: openAttempt.rows[0]?.id ?? '',
                attemptNo: existingRepasse.transferAttempts,
                acao: 'reconciliar' as const,
              };
            }

            // Fresh claim: aprovado | falhou → transferindo (domain-guarded).
            const updated = iniciarTransferencia(existingRepasse);
            await sql`
              UPDATE repasses_recebedor
                SET status = ${updated.status},
                    transfer_attempts = ${updated.transferAttempts},
                    last_transfer_error = NULL
                WHERE id = ${updated.id}
            `.execute(tx);

            const attemptId = randomUUID();
            await sql`
              INSERT INTO repasse_transfer_attempts
                (id, repasse_id, attempt_no, referencia, started_at, request_summary)
                VALUES (${attemptId}, ${updated.id}, ${updated.transferAttempts},
                        ${updated.transferReferencia}, ${input.agora}, ${input.requestSummary})
            `.execute(tx);

            return {
              repasse: updated,
              attemptId,
              attemptNo: updated.transferAttempts,
              acao: 'prosseguir' as const,
            };
          });
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

  async finalizarTentativaTransferencia(input: {
    readonly idRepasse: IdRepasse;
    readonly attemptId: string;
    readonly resultado: RepasseTransferResultado;
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.finalizarTentativa',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          // biome-ignore lint/suspicious/noExplicitAny: see aprovarRepasseTransaction
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            const lockedRows = (await sql<RepasseRow>`
              SELECT * FROM repasses_recebedor WHERE id = ${input.idRepasse} FOR UPDATE
            `.execute(tx)) as unknown as { rows: RepasseRow[] };
            const existing = lockedRows.rows[0];
            if (!existing) {
              throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
            }
            const existingRepasse = repasseFromRow(existing);
            const { resultado } = input;

            let updated: RepasseRecebedor;
            let outcome: string;
            let codigo: string | null = null;
            let erro: string | null = null;

            switch (resultado.tipo) {
              case 'pago': {
                updated = marcarRepassePago(existingRepasse, resultado.codigoSolicitacao);
                outcome = 'pago';
                codigo = resultado.codigoSolicitacao;
                await sql`
                  UPDATE repasses_recebedor
                    SET status = ${updated.status},
                        inter_codigo_solicitacao = ${updated.interCodigoSolicitacao},
                        last_transfer_error = NULL
                    WHERE id = ${updated.id}
                `.execute(tx);
                // §10.1 — the SINGLE debit point: stamp transferido_em now.
                await sql`
                  UPDATE lancamentos_financeiros
                    SET transferido_em = ${input.agora}
                    WHERE id_repasse = ${updated.id}
                      AND transferido_em IS NULL
                      AND cancelado_em IS NULL
                `.execute(tx);
                break;
              }
              case 'verificando': {
                updated = marcarRepasseVerificando(existingRepasse, resultado.codigoSolicitacao);
                outcome = 'verificando';
                codigo = updated.interCodigoSolicitacao;
                await sql`
                  UPDATE repasses_recebedor
                    SET status = ${updated.status},
                        inter_codigo_solicitacao = ${updated.interCodigoSolicitacao}
                    WHERE id = ${updated.id}
                `.execute(tx);
                break;
              }
              case 'falhou': {
                updated = marcarRepasseFalhou(existingRepasse, resultado.erro);
                outcome = 'falhou';
                erro = resultado.erro;
                await sql`
                  UPDATE repasses_recebedor
                    SET status = ${updated.status},
                        last_transfer_error = ${updated.lastTransferError}
                    WHERE id = ${updated.id}
                `.execute(tx);
                break;
              }
              case 'transitorio': {
                // Definitely no payment created — revert so the retry is a
                // clean fresh claim (new attempt, same stable referencia).
                updated = reverterTransferenciaParaAprovado(existingRepasse);
                outcome = 'transitorio';
                erro = resultado.erro;
                await sql`
                  UPDATE repasses_recebedor
                    SET status = ${updated.status}
                    WHERE id = ${updated.id}
                `.execute(tx);
                break;
              }
              default: {
                const _exhaustive: never = resultado;
                throw new Error(`unhandled resultado ${JSON.stringify(_exhaustive)}`);
              }
            }

            // Close the open attempt row.
            await sql`
              UPDATE repasse_transfer_attempts
                SET outcome = ${outcome},
                    codigo_solicitacao = ${codigo},
                    error = ${erro},
                    finished_at = ${input.agora}
                WHERE id = ${input.attemptId}
            `.execute(tx);

            return { repasse: updated };
          });
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

  async resolverVerificacaoTransferencia(input: {
    readonly idRepasse: IdRepasse;
    readonly resultado: RepasseTransferResultadoTerminal;
    readonly reconciliacaoResumo: string;
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.resolverVerificacao',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          // biome-ignore lint/suspicious/noExplicitAny: see aprovarRepasseTransaction
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            const lockedRows = (await sql<RepasseRow>`
              SELECT * FROM repasses_recebedor WHERE id = ${input.idRepasse} FOR UPDATE
            `.execute(tx)) as unknown as { rows: RepasseRow[] };
            const existing = lockedRows.rows[0];
            if (!existing) {
              throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
            }
            const existingRepasse = repasseFromRow(existing);

            // Idempotent: only a verificando repasse is resolvable here.
            if (existingRepasse.status !== 'verificando') {
              return { repasse: existingRepasse };
            }

            const { resultado } = input;
            let updated: RepasseRecebedor;
            let codigo: string | null = null;
            let erro: string | null = null;

            if (resultado.tipo === 'pago') {
              updated = marcarRepassePago(existingRepasse, resultado.codigoSolicitacao);
              codigo = resultado.codigoSolicitacao;
              await sql`
                UPDATE repasses_recebedor
                  SET status = ${updated.status},
                      inter_codigo_solicitacao = ${updated.interCodigoSolicitacao},
                      last_transfer_error = NULL
                  WHERE id = ${updated.id}
              `.execute(tx);
              await sql`
                UPDATE lancamentos_financeiros
                  SET transferido_em = ${input.agora}
                  WHERE id_repasse = ${updated.id}
                    AND transferido_em IS NULL
                    AND cancelado_em IS NULL
              `.execute(tx);
            } else {
              updated = marcarRepasseFalhou(existingRepasse, resultado.erro);
              erro = resultado.erro;
              await sql`
                UPDATE repasses_recebedor
                  SET status = ${updated.status},
                      last_transfer_error = ${updated.lastTransferError}
                  WHERE id = ${updated.id}
              `.execute(tx);
            }

            // Close out the CURRENT attempt row with its reconciled terminal
            // outcome. We UPDATE the existing intent/verificando row (attempt_no
            // = transferAttempts) rather than INSERT a new one: inserting a row
            // that reuses attempt_no collides with the intent row under
            // repasse_transfer_attempts_repasse_attempt_uniq (23505 → the whole
            // resolution rolls back, so a confirmed payment never books). This
            // mirrors finalizarTentativa, which already closes the same row.
            // The reconciliation note is appended to request_summary so the
            // original attempt context is preserved.
            await sql`
              UPDATE repasse_transfer_attempts
                SET outcome = ${resultado.tipo},
                    codigo_solicitacao = COALESCE(${codigo}, codigo_solicitacao),
                    error = ${erro},
                    finished_at = ${input.agora},
                    request_summary = COALESCE(request_summary, '') || ${` | reconciliacao: ${input.reconciliacaoResumo}`}
                WHERE repasse_id = ${updated.id}
                  AND attempt_no = ${updated.transferAttempts}
            `.execute(tx);

            return { repasse: updated };
          });
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

  async cancelarRepasseTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly canceladoPor: string;
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor; readonly lancamentosLiberados: number }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.cancelarTransaction',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          // biome-ignore lint/suspicious/noExplicitAny: see aprovarRepasseTransaction
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            const lockedRows = (await sql<RepasseRow>`
              SELECT * FROM repasses_recebedor WHERE id = ${input.idRepasse} FOR UPDATE
            `.execute(tx)) as unknown as { rows: RepasseRow[] };
            const existing = lockedRows.rows[0];
            if (!existing) {
              throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
            }
            const existingRepasse = repasseFromRow(existing);

            // Domain-guarded: falhou → cancelado (only claim-release path).
            const updated = cancelarRepasse(existingRepasse);
            await sql`
              UPDATE repasses_recebedor
                SET status = ${updated.status}
                WHERE id = ${updated.id}
            `.execute(tx);

            // Release the claim: clear id_repasse on the linked, un-transferred
            // lançamentos so the funds return to the disponivel bucket.
            const releaseResult = await sql`
              UPDATE lancamentos_financeiros
                SET id_repasse = NULL
                WHERE id_repasse = ${updated.id}
                  AND transferido_em IS NULL
            `.execute(tx);
            const lancamentosLiberados = Number(releaseResult.numAffectedRows ?? 0n);

            // Audit row carrying the acting admin (no PII beyond the admin id).
            // Cancel is NOT a payment attempt — it must not reuse the last
            // attempt_no (that collides with the intent row under
            // repasse_transfer_attempts_repasse_attempt_uniq → 23505, killing
            // the only claim-release path). Give it its own number via MAX+1.
            // This is collision-free because `cancelado` is terminal: no
            // future iniciarTransferencia can ever claim MAX+1 (cancel and a
            // racing retry are mutually exclusive under FOR UPDATE).
            await sql`
              INSERT INTO repasse_transfer_attempts
                (id, repasse_id, attempt_no, referencia, started_at,
                 request_summary, outcome, finished_at)
                SELECT ${randomUUID()}, ${updated.id},
                       COALESCE(MAX(attempt_no), 0) + 1,
                       ${updated.transferReferencia ?? ''}, ${input.agora},
                       ${`cancelado_por:${input.canceladoPor}`}, ${'cancelado'}, ${input.agora}
                  FROM repasse_transfer_attempts
                  WHERE repasse_id = ${updated.id}
            `.execute(tx);

            return { repasse: updated, lancamentosLiberados };
          });
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

  async flagNeedsManualResolutionTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly candidatos: readonly RepasseReconciliacaoCandidato[];
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.flagNeedsManualResolution',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          // biome-ignore lint/suspicious/noExplicitAny: see aprovarRepasseTransaction
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            const lockedRows = (await sql<RepasseRow>`
              SELECT * FROM repasses_recebedor WHERE id = ${input.idRepasse} FOR UPDATE
            `.execute(tx)) as unknown as { rows: RepasseRow[] };
            const existing = lockedRows.rows[0];
            if (!existing) {
              throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
            }
            const existingRepasse = repasseFromRow(existing);

            // Idempotent: only a verificando repasse gets flagged here.
            if (existingRepasse.status !== 'verificando') {
              return { repasse: existingRepasse };
            }

            const updated = marcarRepasseNeedsManualResolution(existingRepasse);
            await sql`
              UPDATE repasses_recebedor
                SET needs_manual_resolution = TRUE
                WHERE id = ${updated.id}
            `.execute(tx);

            // Persist candidates — idempotent on (repasse_id, codigo_solicitacao)
            // so a re-run of the search never double-inserts. chave is stored
            // MASKED only (never the full chave at rest — Cipher gate).
            for (const c of input.candidatos) {
              await sql`
                INSERT INTO repasse_reconciliacao_candidatos
                  (id, repasse_id, codigo_solicitacao, valor_cents, data_movimento,
                   chave_mascarada, descricao_pix, criado_em)
                  VALUES (${randomUUID()}, ${updated.id}, ${c.codigoSolicitacao},
                          ${c.valorCents}, ${c.dataMovimento}, ${c.chaveMascarada},
                          ${c.descricaoPix}, ${input.agora})
                  ON CONFLICT (repasse_id, codigo_solicitacao) DO NOTHING
              `.execute(tx);
            }

            return { repasse: updated };
          });
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

  async resolverManualPagoTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly interCodigoSolicitacao: string;
    readonly resolvidoPor: string;
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.resolverManualPago',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          // biome-ignore lint/suspicious/noExplicitAny: see aprovarRepasseTransaction
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            const lockedRows = (await sql<RepasseRow>`
              SELECT * FROM repasses_recebedor WHERE id = ${input.idRepasse} FOR UPDATE
            `.execute(tx)) as unknown as { rows: RepasseRow[] };
            const existing = lockedRows.rows[0];
            if (!existing) {
              throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
            }
            const existingRepasse = repasseFromRow(existing);

            // Idempotent: only a verificando + flagged repasse is manually
            // resolvable. Anything else (already resolved) is a no-op.
            if (
              existingRepasse.status !== 'verificando' ||
              !existingRepasse.needsManualResolution
            ) {
              return { repasse: existingRepasse };
            }

            // Domain guard books like auto-pago (records the admin-supplied
            // codigo, clears error + flag).
            const updated = resolverManualPago(existingRepasse, input.interCodigoSolicitacao);
            await sql`
              UPDATE repasses_recebedor
                SET status = ${updated.status},
                    inter_codigo_solicitacao = ${updated.interCodigoSolicitacao},
                    last_transfer_error = NULL,
                    needs_manual_resolution = FALSE
                WHERE id = ${updated.id}
            `.execute(tx);
            // §10.1 single debit point — identical to the auto-pago path.
            await sql`
              UPDATE lancamentos_financeiros
                SET transferido_em = ${input.agora}
                WHERE id_repasse = ${updated.id}
                  AND transferido_em IS NULL
                  AND cancelado_em IS NULL
            `.execute(tx);

            // Audit row carrying the acting admin. Manual resolution is NOT a
            // payment attempt — number it MAX+1 (collision-free; the repasse is
            // now terminal-pago) rather than reuse the intent attempt_no.
            await sql`
              INSERT INTO repasse_transfer_attempts
                (id, repasse_id, attempt_no, referencia, started_at,
                 request_summary, outcome, codigo_solicitacao, finished_at)
                SELECT ${randomUUID()}, ${updated.id},
                       COALESCE(MAX(attempt_no), 0) + 1,
                       ${updated.transferReferencia ?? ''}, ${input.agora},
                       ${`resolucao_manual_pago_por:${input.resolvidoPor}`}, ${'pago'},
                       ${input.interCodigoSolicitacao}, ${input.agora}
                  FROM repasse_transfer_attempts
                  WHERE repasse_id = ${updated.id}
            `.execute(tx);

            return { repasse: updated };
          });
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

  async resolverManualFalhouTransaction(input: {
    readonly idRepasse: IdRepasse;
    readonly erro: string;
    readonly resolvidoPor: string;
    readonly agora: Date;
  }): Promise<{ readonly repasse: RepasseRecebedor }> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.resolverManualFalhou',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          // biome-ignore lint/suspicious/noExplicitAny: see aprovarRepasseTransaction
          const result = await (this.db as any).transaction().execute(async (tx: any) => {
            const lockedRows = (await sql<RepasseRow>`
              SELECT * FROM repasses_recebedor WHERE id = ${input.idRepasse} FOR UPDATE
            `.execute(tx)) as unknown as { rows: RepasseRow[] };
            const existing = lockedRows.rows[0];
            if (!existing) {
              throw new FinanceiroRepasseNaoEncontradoError(input.idRepasse);
            }
            const existingRepasse = repasseFromRow(existing);

            if (
              existingRepasse.status !== 'verificando' ||
              !existingRepasse.needsManualResolution
            ) {
              return { repasse: existingRepasse };
            }

            const updated = resolverManualFalhou(existingRepasse, input.erro);
            await sql`
              UPDATE repasses_recebedor
                SET status = ${updated.status},
                    last_transfer_error = ${updated.lastTransferError},
                    needs_manual_resolution = FALSE
                WHERE id = ${updated.id}
            `.execute(tx);

            // Audit row — MAX+1 (not a payment attempt). No money moved.
            await sql`
              INSERT INTO repasse_transfer_attempts
                (id, repasse_id, attempt_no, referencia, started_at,
                 request_summary, outcome, error, finished_at)
                SELECT ${randomUUID()}, ${updated.id},
                       COALESCE(MAX(attempt_no), 0) + 1,
                       ${updated.transferReferencia ?? ''}, ${input.agora},
                       ${`resolucao_manual_falhou_por:${input.resolvidoPor}`}, ${'falhou'},
                       ${input.erro}, ${input.agora}
                  FROM repasse_transfer_attempts
                  WHERE repasse_id = ${updated.id}
            `.execute(tx);

            return { repasse: updated };
          });
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

  async findCandidatosByRepasseId(
    idRepasse: IdRepasse,
  ): Promise<readonly RepasseReconciliacaoCandidato[]> {
    return tracer.startActiveSpan('db.financeiro_livro.repasses.findCandidatos', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const rows = (await sql<{
          codigo_solicitacao: string;
          valor_cents: number;
          data_movimento: string | null;
          chave_mascarada: string | null;
          descricao_pix: string | null;
        }>`
            SELECT codigo_solicitacao, valor_cents, data_movimento, chave_mascarada, descricao_pix
              FROM repasse_reconciliacao_candidatos
              WHERE repasse_id = ${idRepasse}
              ORDER BY criado_em ASC
          `.execute(this.db)) as unknown as {
          rows: Array<{
            codigo_solicitacao: string;
            valor_cents: number;
            data_movimento: string | null;
            chave_mascarada: string | null;
            descricao_pix: string | null;
          }>;
        };
        span.setStatus({ code: SpanStatusCode.OK });
        return rows.rows.map((r) => ({
          codigoSolicitacao: r.codigo_solicitacao,
          valorCents: r.valor_cents,
          dataMovimento: r.data_movimento,
          chaveMascarada: r.chave_mascarada,
          descricaoPix: r.descricao_pix,
        }));
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findTransferAttemptsByRepasseId(
    idRepasse: IdRepasse,
  ): Promise<readonly RepasseTransferAttempt[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.repasses.findTransferAttempts',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const rows = (await sql<TransferAttemptRow>`
            SELECT id, repasse_id, attempt_no, referencia, started_at, finished_at,
                   request_summary, outcome, codigo_solicitacao, error
              FROM repasse_transfer_attempts
              WHERE repasse_id = ${idRepasse}
              ORDER BY attempt_no ASC, started_at ASC
          `.execute(this.db)) as unknown as { rows: TransferAttemptRow[] };
          const result = rows.rows.map(transferAttemptFromRow);
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
}

/** Aggregate → row mapper for LancamentoFinanceiro. */
function rowFromLancamento(l: LancamentoFinanceiro): Record<string, unknown> {
  return {
    id: l.id,
    id_pagamento: l.idPagamento,
    // Plan 0016 Phase 2 / migration 023: NOT NULL FK to intencao_items.id.
    // The entity always carries it (factory throws if any item lacks ids),
    // so this is never null at this point.
    id_item_pagamento: l.idItemPagamento,
    id_contribuicao: l.idContribuicao,
    id_campanha: l.idCampanha ?? null,
    tipo: l.tipo,
    amount_cents: l.amountCents,
    criado_em: l.criadoEm,
    transferido_em: l.transferidoEm,
    cancelado_em: l.canceladoEm,
    id_repasse: l.idRepasse,
  };
}

/** Row → aggregate mapper for LancamentoFinanceiro. */
function lancamentoFromRow(row: LancamentoRow): LancamentoFinanceiro {
  return LancamentoFinanceiroSchema.parse({
    id: row.id,
    idPagamento: row.id_pagamento,
    // Plan 0016 Phase 2 / migration 023.
    idItemPagamento: row.id_item_pagamento,
    idContribuicao: row.id_contribuicao,
    idCampanha: row.id_campanha ?? undefined,
    tipo: row.tipo,
    amountCents: row.amount_cents,
    criadoEm: row.criado_em,
    transferidoEm: row.transferido_em,
    canceladoEm: row.cancelado_em,
    idRepasse: row.id_repasse,
  });
}

/** Aggregate → row mapper for RepasseRecebedor. */
function rowFromRepasse(r: RepasseRecebedor): Record<string, unknown> {
  return {
    id: r.id,
    id_campanha: r.idCampanha,
    amount_cents: r.amountCents,
    status: r.status,
    solicitado_em: r.solicitadoEm,
    aprovado_em: r.aprovadoEm,
    bank_transfer_ref: r.bankTransferRef,
  };
}

/** Row → aggregate mapper for RepasseRecebedor. */
function repasseFromRow(row: RepasseRow): RepasseRecebedor {
  return RepasseRecebedorSchema.parse({
    id: row.id,
    idCampanha: row.id_campanha,
    amountCents: row.amount_cents,
    status: row.status,
    solicitadoEm: row.solicitado_em,
    aprovadoEm: row.aprovado_em,
    bankTransferRef: row.bank_transfer_ref,
    transferReferencia: row.transfer_referencia,
    interCodigoSolicitacao: row.inter_codigo_solicitacao,
    transferAttempts: row.transfer_attempts,
    lastTransferError: row.last_transfer_error,
    needsManualResolution: row.needs_manual_resolution,
  });
}

type TransferAttemptRow = {
  id: string;
  repasse_id: string;
  attempt_no: number;
  referencia: string;
  started_at: Date;
  finished_at: Date | null;
  request_summary: string | null;
  outcome: string | null;
  codigo_solicitacao: string | null;
  error: string | null;
};

function transferAttemptFromRow(row: TransferAttemptRow): RepasseTransferAttempt {
  return {
    id: row.id,
    repasseId: row.repasse_id as RepasseTransferAttempt['repasseId'],
    attemptNo: row.attempt_no,
    referencia: row.referencia,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    requestSummary: row.request_summary,
    outcome: row.outcome,
    codigoSolicitacao: row.codigo_solicitacao,
    error: row.error,
  };
}

/**
 * aperture-vvh2j — wraps a Kysely transaction into the minimal
 * `RepasseTransactionExecutor` shape (structurally compatible with
 * pg-boss's `db` option), so a job insert can ride the SAME transaction
 * as the FSM write. Raw SQL is executed on the transaction's own
 * connection via `CompiledQuery.raw`.
 */
function buildRepasseExecutor(tx: unknown): RepasseTransactionExecutor {
  return {
    async executeSql(text: string, values: readonly unknown[]) {
      // biome-ignore lint/suspicious/noExplicitAny: Kysely Transaction handle, opaque at this layer.
      const result = await (tx as any).executeQuery(CompiledQuery.raw(text, [...values]));
      return { rows: (result.rows ?? []) as ReadonlyArray<Record<string, unknown>> };
    },
  };
}
