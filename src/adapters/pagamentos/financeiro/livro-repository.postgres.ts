import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { IdCampanha } from '../../../domain/arrecadacao/value-objects/ids.js';
import {
  type LancamentoFinanceiro,
  LancamentoFinanceiroSchema,
} from '../../../domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import {
  aprovarRepasse,
  criarRepasseRecebedorSolicitado,
  type RepasseRecebedor,
  RepasseRecebedorSchema,
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
import type { LivroFinanceiroRepository } from './livro-repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'financeiro_livro',
} as const;

/**
 * Constraint name from migration 20260531_012_create_financeiro — matched
 * verbatim to surface `FinanceiroPagamentoJaRegistradoError` on duplicate
 * (id_pagamento, tipo) insert (port-conformance with the memory adapter,
 * which preflight-checks and throws the same typed error).
 */
const UNIQUE_PAGAMENTO_TIPO = 'lancamentos_financeiros_id_pagamento_tipo_uniq';
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
 */
type LancamentoRow = {
  id: string;
  id_pagamento: string;
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

        // biome-ignore lint/suspicious/noExplicitAny: row shape uses
        // Record<string, unknown> for the heterogeneous date+null inserts;
        // the Kysely DB type doesn't narrow that cleanly.
        await (this.db as any).insertInto('lancamentos_financeiros').values(rows).execute();

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        if (isUniqueViolation(error, UNIQUE_PAGAMENTO_TIPO)) {
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
    readonly statusFilter: 'solicitado' | 'aprovado' | 'all';
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
          // biome-ignore lint/suspicious/noExplicitAny: see saveLancamentos
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
          // biome-ignore lint/suspicious/noExplicitAny: Kysely tx type
          // narrowing isn't worth chasing for the heterogeneous mix of
          // sql`` + insertInto here.
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
  });
}
