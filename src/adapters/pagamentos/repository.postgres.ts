import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { IdCampanha, IdContribuicao } from '../../domain/arrecadacao/value-objects/ids.js';
import {
  type ItemDoPagamento,
  ItemDoPagamentoSchema,
} from '../../domain/pagamentos/entities/item-do-pagamento.js';
import { type Pagamento, PagamentoSchema } from '../../domain/pagamentos/entities/pagamento.js';
import type {
  IdContribuicaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentoJaExisteError } from '../../errors/pagamentos/ja-existe.error.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import type { Database } from '../database.js';
import type { DB } from '../db-types.generated.js';
import type { AdminRecadoRow, MuralRecadoProjection, PagamentoRepository } from './repository.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'pagamentos',
} as const;

/**
 * Constraint name from migration 20260531_011_create_pagamentos — matched
 * verbatim to surface `PagamentoJaExisteError` on (id, intencao_id)
 * collision (port-conformance with the memory adapter).
 */
const UNIQUE_INTENCAO_ID = 'pagamentos_intencao_id_uniq';

/**
 * Plan 0016 (aperture-aj8qw) typecheck-trap fix + multi-item cart rewrite.
 *
 * Pre-0016 this file declared its own hand-written `PagamentoRow` type
 * that mirrored the pagamentos schema by convention. That mirror
 * silently went stale when Phase 0 dropped the per-pagamento
 * id_contribuicao + composição-JSONB columns and renamed amount_cents
 * to total_paid_cents, since the hand-written type still matched what
 * the queries SELECTed regardless of whether those columns existed at
 * runtime.
 *
 * Phase 1 of plan 0016 lifts the row shape to kysely-codegen's
 * `Pagamentos` interface directly + adds the new `intencao_items` row
 * shape from the same generated file. Hydration is split into two
 * helpers: one for the pagamento row, one for the per-item rows; the
 * Pagamento aggregate is reconstructed from both.
 *
 * Same JSONB `unknown` → parsed `Pagamento` flow at the schema-parse
 * boundary; same span-instrumentation conventions; same constraint-name
 * mapping for unique-violation → `PagamentoJaExisteError`. The wire
 * shape just expanded by one table.
 */
type PagamentoRow = import('../db-types.generated.js').Pagamentos;
type ItemRow = import('../db-types.generated.js').IntencaoItems;

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
 * PostgreSQL adapter for `PagamentoRepository` (aperture-xaha2). First
 * production wiring of the Pagamento BC — until aperture-xaha2 landed,
 * only the in-memory adapter existed.
 *
 * Shape decisions:
 *   - The IntencaoPagamento embedded entity is FLATTENED into top-level
 *     `intencao_*` columns on `pagamentos` for lookup-by-field convenience
 *     (e.g. the external_ref partial indexes). The TransacaoExterna
 *     embedded entity stays as a single JSONB column — never queried by
 *     inner field; only loaded with the aggregate root.
 *   - Per plan 0016 (aperture-aj8qw): item-level decomposition lives in
 *     the separate `intencao_items` table (1:N from pagamentos). Cart
 *     reads do an explicit second SELECT per pagamento; this keeps the
 *     hydration straightforward and lets the discriminator CHECK + the
 *     position-ordering UNIQUE constraint enforce shape DB-side.
 *   - Save/update insert/replace the full aggregate atomically inside a
 *     transaction — pagamento row + items together, no partial state.
 */
export class PagamentoRepositoryPostgres implements PagamentoRepository {
  constructor(private readonly db: Database) {}

  async save(pagamento: Pagamento): Promise<void> {
    return tracer.startActiveSpan('db.pagamentos.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        await this.db.transaction().execute(async (trx) => {
          // Cast through any to satisfy kysely's `Insertable<pagamentos>`
          // ColumnType-branded shape vs the plain row object.
          await trx
            .insertInto('pagamentos')
            // biome-ignore lint/suspicious/noExplicitAny: kysely Insertable brand vs plain row object
            .values(rowFromPagamento(pagamento) as any)
            .execute();
          await insertItemsForPagamento(trx, pagamento);
        });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        if (isUniqueViolation(error, UNIQUE_INTENCAO_ID)) {
          const typed = new PagamentoJaExisteError(pagamento.id, pagamento.intencao.id);
          span.recordException(typed);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw typed;
        }
        // Primary-key collision on `id` — also a "ja existe" case (the
        // memory adapter throws PagamentoJaExisteError when the map
        // already holds the id). Map it the same way for port-conformance.
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as PostgresError).code === '23505'
        ) {
          const typed = new PagamentoJaExisteError(pagamento.id, pagamento.intencao.id);
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
    });
  }

  async update(pagamento: Pagamento): Promise<void> {
    return tracer.startActiveSpan('db.pagamentos.update', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        await this.db.transaction().execute(async (trx) => {
          const result = await trx
            .updateTable('pagamentos')
            // biome-ignore lint/suspicious/noExplicitAny: kysely Updateable brand vs plain row object
            .set(rowFromPagamento(pagamento) as any)
            .where('id', '=', pagamento.id)
            .executeTakeFirst();

          // Match memory-adapter semantics: throw when no row was matched
          // (caller treated this as "must exist").
          const matched =
            typeof result?.numUpdatedRows === 'bigint'
              ? Number(result.numUpdatedRows)
              : (result?.numUpdatedRows ?? 0);
          if (matched === 0) {
            throw new PagamentoNaoEncontradoError(pagamento.id);
          }

          // intencao_items are WRITE-ONCE at save() (aperture-t0sxe). The
          // cart is fixed at checkout-session creation and NO flow mutates
          // `intencao.items` afterward — every update() is metadata-only
          // (status / available_on / pi-ref / charge-ref / contribuinte).
          //
          // We deliberately do NOT delete+reinsert the items here. The old
          // wholesale-replace was a latent data-integrity bug:
          // `lancamentos_financeiros.id_item_pagamento` has an ON DELETE
          // CASCADE FK to `intencao_items(id)` (migration 023), so deleting
          // the items on a metadata-only update CASCADE-DELETES the booked
          // financial ledger. That was the t0sxe card race: charge.succeeded
          // booked the lancamentos, then a near-concurrent
          // checkout.session.completed update() (persisting available_on)
          // wiped them via this cascade — card payments silently lost their
          // lancamentos and vanished from the extrato (PIX was unaffected
          // because its events are spaced, so no metadata-update overlapped a
          // fresh booking). update() now touches ONLY the pagamentos row.
        });
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
        const row = await this.db
          .selectFrom('pagamentos')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        if (!row) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        const items = await loadItemsForPagamento(this.db, id);
        span.setStatus({ code: SpanStatusCode.OK });
        return pagamentoFromRow(row as unknown as PagamentoRow, items);
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
   * Find all pagamentos referencing the given contribuição. Post-plan-0016
   * the reference moved to per-item — bridges through the
   * `intencao_items` table via `idx_intencao_items_contribuicao_aprovado`
   * (partial index on `id_contribuicao IS NOT NULL`).
   *
   * Returns ALL matches in `criado_em ASC` order — a single contribuição
   * may participate in multiple carts over time (locked decision #6 of
   * plan 0015 + the multi-item carts of plan 0016 both allow this).
   */
  async findByContribuicao(idContribuicao: IdContribuicaoPagamento): Promise<readonly Pagamento[]> {
    return tracer.startActiveSpan('db.pagamentos.findByContribuicao', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const rows = await this.db
          .selectFrom('pagamentos')
          .innerJoin('intencao_items', 'intencao_items.id_pagamento', 'pagamentos.id')
          .selectAll('pagamentos')
          .distinct()
          .where('intencao_items.id_contribuicao', '=', idContribuicao)
          .orderBy('pagamentos.criado_em', 'asc')
          .execute();
        const pagamentos: Pagamento[] = [];
        for (const row of rows) {
          const items = await loadItemsForPagamento(this.db, row.id as IdPagamento);
          pagamentos.push(pagamentoFromRow(row as unknown as PagamentoRow, items));
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return pagamentos;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByExternalRef(externalRef: string): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan('db.pagamentos.findByExternalRef', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const row = await this.db
          .selectFrom('pagamentos')
          .selectAll()
          .where('intencao_external_ref', '=', externalRef)
          .executeTakeFirst();
        if (!row) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        const items = await loadItemsForPagamento(this.db, row.id as IdPagamento);
        span.setStatus({ code: SpanStatusCode.OK });
        return pagamentoFromRow(row as unknown as PagamentoRow, items);
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
        // aperture-wif8s: uses partial index
        // `pagamentos_intencao_pi_ref_idx ON
        // (intencao_payment_intent_external_ref) WHERE … IS NOT NULL`
        // (migration 018) for selective scan.
        const row = await this.db
          .selectFrom('pagamentos')
          .selectAll()
          .where('intencao_payment_intent_external_ref', '=', pi)
          .executeTakeFirst();
        if (!row) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        const items = await loadItemsForPagamento(this.db, row.id as IdPagamento);
        span.setStatus({ code: SpanStatusCode.OK });
        return pagamentoFromRow(row as unknown as PagamentoRow, items);
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
        // aperture-wif8s: uses partial index
        // `pagamentos_intencao_ch_ref_idx ON
        // (intencao_charge_external_ref) WHERE … IS NOT NULL`
        // (migration 018).
        const row = await this.db
          .selectFrom('pagamentos')
          .selectAll()
          .where('intencao_charge_external_ref', '=', ch)
          .executeTakeFirst();
        if (!row) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }
        const items = await loadItemsForPagamento(this.db, row.id as IdPagamento);
        span.setStatus({ code: SpanStatusCode.OK });
        return pagamentoFromRow(row as unknown as PagamentoRow, items);
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
   * Plan 0016 Phase 2 (aperture-eg1s2): replaces the pre-0016 binary
   * predicate `findIdsContribuicoesComPagamentoAprovado` with a SUM
   * aggregator. Returns total `quantidade` consumed per contribuição
   * across all aprovado items.
   *
   * Uses the partial index `idx_intencao_items_contribuicao_aprovado`
   * INCLUDE (quantidade) — covering for the aggregation — joined
   * against `pagamentos.status='aprovado'`. One indexed query for
   * the whole input set.
   *
   * Missing keys are returned as 0 — caller can iterate the input set
   * confidently. Overshoot (sum > contribuicao.quantidade) is OK per
   * locked decision #10; the use-case surfaces `esgotada=true` when
   * `quantidadeRestante <= 0`.
   */
  async somarQuantidadesContribuicoesEmPagamentosAprovados(
    idsContribuicao: readonly IdContribuicaoPagamento[],
  ): Promise<Map<IdContribuicaoPagamento, number>> {
    return tracer.startActiveSpan(
      'db.pagamentos.somarQuantidadesContribuicoesEmPagamentosAprovados',
      async (span) => {
        span.setAttributes({
          ...DB_ATTRS,
          'db.operation.name': 'SELECT',
          'batch.size': idsContribuicao.length,
        });
        try {
          const result = new Map<IdContribuicaoPagamento, number>();
          for (const id of idsContribuicao) {
            result.set(id, 0);
          }
          if (idsContribuicao.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          }
          const rows = await this.db
            .selectFrom('intencao_items')
            .innerJoin('pagamentos', 'pagamentos.id', 'intencao_items.id_pagamento')
            .select([
              'intencao_items.id_contribuicao as id_contribuicao',
              (eb) => eb.fn.sum<string>('intencao_items.quantidade').as('total'),
            ])
            .where('pagamentos.status', '=', 'aprovado')
            .where('intencao_items.tipo', '=', 'contribuicao')
            .where('intencao_items.id_contribuicao', 'in', [...idsContribuicao])
            .groupBy('intencao_items.id_contribuicao')
            .execute();
          for (const r of rows) {
            if (r.id_contribuicao === null) continue;
            result.set(r.id_contribuicao as IdContribuicaoPagamento, Number(r.total));
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
   * Plan 0016 (aperture-aj8qw): the most-recent aprovado pagamento per
   * contribuição is now resolved via `intencao_items`. The contribuinte
   * lives at `pagamentos.intencao_contribuinte_*` (root of IntencaoPagamento
   * per plan 0015 / aperture-7pqee — NOT per-item). The query:
   *
   *   - JOIN `intencao_items` ON `pagamentos.id`
   *   - WHERE `id_contribuicao IN (…)` AND `status='aprovado'`
   *   - DISTINCT ON `(id_contribuicao)` ORDER BY `criado_em DESC`
   *
   * picks the most-recent aprovado pagamento per contribuição. The
   * partial index `idx_intencao_items_contribuicao_aprovado` serves the
   * id_contribuicao filter; the (id_contribuicao, criado_em) sort uses
   * an in-memory sort on the small post-WHERE set.
   */
  async findContribuintesFromLatestAprovadoPagamento(
    idsContribuicao: readonly IdContribuicaoPagamento[],
  ): Promise<Map<string, { nome: string; email: string; mensagem?: string } | null>> {
    return tracer.startActiveSpan(
      'db.pagamentos.findContribuintesFromLatestAprovadoPagamento',
      async (span) => {
        span.setAttributes({
          ...DB_ATTRS,
          'db.operation.name': 'SELECT',
          'batch.size': idsContribuicao.length,
        });
        try {
          const result = new Map<
            string,
            { nome: string; email: string; mensagem?: string } | null
          >();
          if (idsContribuicao.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          }
          const rows = await this.db
            .selectFrom('intencao_items')
            .innerJoin('pagamentos', 'pagamentos.id', 'intencao_items.id_pagamento')
            .select([
              'intencao_items.id_contribuicao as id_contribuicao',
              'pagamentos.intencao_contribuinte_nome as intencao_contribuinte_nome',
              'pagamentos.intencao_contribuinte_email as intencao_contribuinte_email',
              'pagamentos.intencao_contribuinte_mensagem as intencao_contribuinte_mensagem',
              'pagamentos.criado_em as criado_em',
            ])
            .where('pagamentos.status', '=', 'aprovado')
            .where('intencao_items.id_contribuicao', 'in', [...idsContribuicao])
            .orderBy('intencao_items.id_contribuicao')
            .orderBy('pagamentos.criado_em', 'desc')
            .execute();

          // Sorted by id_contribuicao ASC, criado_em DESC. The first row
          // per id_contribuicao is the most-recent aprovado pagamento.
          const seen = new Set<string>();
          for (const row of rows) {
            const idC = row.id_contribuicao;
            if (idC === null) continue;
            if (seen.has(idC)) continue;
            seen.add(idC);
            const hasContribuinte =
              row.intencao_contribuinte_nome !== null && row.intencao_contribuinte_email !== null;
            if (!hasContribuinte) {
              result.set(idC, null);
              continue;
            }
            result.set(idC, {
              nome: row.intencao_contribuinte_nome as string,
              email: row.intencao_contribuinte_email as string,
              ...(row.intencao_contribuinte_mensagem !== null
                ? { mensagem: row.intencao_contribuinte_mensagem }
                : {}),
            });
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
   * aperture-7eci9 — visitor mural read. Single indexed query over
   * `pagamentos` filtered by `status='aprovado' AND intencao_id_campanha=$1
   * AND intencao_contribuinte_mensagem IS NOT NULL`, ordered by
   * `criado_em DESC` and capped at `limit`.
   *
   * The mensagem column is flattened on the pagamentos row (per the same
   * shape decision documented at the top of this file — IntencaoPagamento
   * fields hoisted for lookup-by-field), so this scans the row table
   * directly with no joins. Empty-string mensagens are dropped in the
   * adapter post-filter for parity with the memory adapter; the trimmed
   * non-empty rule keeps "whitespace-only" rows out of the mural without
   * forcing a CHECK constraint on the column.
   */
  async findMensagensMuralByCampanha(
    idCampanha: IdCampanha,
    limit: number,
  ): Promise<readonly MuralRecadoProjection[]> {
    return tracer.startActiveSpan('db.pagamentos.findMensagensMuralByCampanha', async (span) => {
      span.setAttributes({
        ...DB_ATTRS,
        'db.operation.name': 'SELECT',
        'mural.limit': limit,
      });
      try {
        if (limit <= 0) {
          span.setStatus({ code: SpanStatusCode.OK });
          return [];
        }
        const rows = await this.db
          .selectFrom('pagamentos')
          .select([
            'pagamentos.id as id',
            'pagamentos.intencao_contribuinte_nome as intencao_contribuinte_nome',
            'pagamentos.intencao_contribuinte_mensagem as intencao_contribuinte_mensagem',
            'pagamentos.criado_em as criado_em',
          ])
          .where('pagamentos.status', '=', 'aprovado')
          .where('pagamentos.intencao_id_campanha', '=', idCampanha)
          .where('pagamentos.intencao_contribuinte_mensagem', 'is not', null)
          .where('pagamentos.intencao_contribuinte_nome', 'is not', null)
          .orderBy('pagamentos.criado_em', 'desc')
          .limit(limit)
          .execute();

        const projection: MuralRecadoProjection[] = [];
        for (const row of rows) {
          const nome = row.intencao_contribuinte_nome;
          const mensagem = row.intencao_contribuinte_mensagem;
          if (nome === null || mensagem === null) continue;
          if (mensagem.trim().length === 0) continue;
          projection.push({
            idPagamento: row.id as IdPagamento,
            contribuinteNome: nome,
            mensagem,
            criadoEm: row.criado_em as Date,
          });
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return projection;
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
   * Same `intencao_id_campanha` + `status = 'aprovado'` +
   * `intencao_contribuinte_mensagem IS NOT NULL` filter as the
   * visitor mural. Adds `mensagem_lida_em` + aggregate's
   * `intencao_total_contribution_cents` + the first contribuição
   * item's `id_contribuicao` (looked up via LEFT JOIN LATERAL on
   * `intencao_items` filtered to `tipo = 'contribuicao'` ordered by
   * `position` ASC). No JOIN to contribuicoes — name resolution
   * happens in the use-case via the contribuição repository.
   */
  async findRecadosAdminByCampanha(idCampanha: IdCampanha): Promise<readonly AdminRecadoRow[]> {
    return tracer.startActiveSpan('db.pagamentos.findRecadosAdminByCampanha', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const rows = await this.db
          .selectFrom('pagamentos')
          .leftJoinLateral(
            (eb) =>
              eb
                .selectFrom('intencao_items')
                .select('id_contribuicao')
                .whereRef('intencao_items.id_pagamento', '=', 'pagamentos.id')
                .where('intencao_items.tipo', '=', 'contribuicao')
                .orderBy('intencao_items.position', 'asc')
                .limit(1)
                .as('first_item'),
            (join) => join.onTrue(),
          )
          .select([
            'pagamentos.id as id',
            'pagamentos.intencao_contribuinte_nome as intencao_contribuinte_nome',
            'pagamentos.intencao_contribuinte_mensagem as intencao_contribuinte_mensagem',
            'pagamentos.criado_em as criado_em',
            'pagamentos.mensagem_lida_em as mensagem_lida_em',
            'pagamentos.intencao_total_contribution_cents as intencao_total_contribution_cents',
            'first_item.id_contribuicao as id_primeira_contribuicao',
          ])
          .where('pagamentos.status', '=', 'aprovado')
          .where('pagamentos.intencao_id_campanha', '=', idCampanha)
          .where('pagamentos.intencao_contribuinte_mensagem', 'is not', null)
          .where('pagamentos.intencao_contribuinte_nome', 'is not', null)
          .orderBy('pagamentos.criado_em', 'desc')
          .execute();

        const projection: AdminRecadoRow[] = [];
        for (const row of rows) {
          const nome = row.intencao_contribuinte_nome;
          const mensagem = row.intencao_contribuinte_mensagem;
          if (nome === null || mensagem === null) continue;
          if (mensagem.trim().length === 0) continue;
          projection.push({
            idPagamento: row.id as IdPagamento,
            contribuinteNome: nome,
            mensagem,
            criadoEm: row.criado_em as Date,
            lidaEm: (row.mensagem_lida_em as Date | null) ?? null,
            valorContribuicaoCents: Number(row.intencao_total_contribution_cents),
            idPrimeiraContribuicao: (row.id_primeira_contribuicao as IdContribuicao | null) ?? null,
          });
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return projection;
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
   * Strategy: try UPDATE-WHERE-IS-NULL; if matched, return the new
   * value; otherwise SELECT the existing value. Throws
   * `PagamentoNaoEncontradoError` when the row doesn't exist at all
   * (the use-case treats this as a programming error, same posture
   * as `findById` / `update`).
   */
  async marcarRecadoLido(idPagamento: IdPagamento, lidaEm: Date): Promise<Date> {
    return tracer.startActiveSpan('db.pagamentos.marcarRecadoLido', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const updated = await this.db
          .updateTable('pagamentos')
          .set({ mensagem_lida_em: lidaEm })
          .where('id', '=', idPagamento)
          .where('mensagem_lida_em', 'is', null)
          .returning('mensagem_lida_em')
          .executeTakeFirst();
        if (updated !== undefined && updated.mensagem_lida_em !== null) {
          span.setStatus({ code: SpanStatusCode.OK });
          return updated.mensagem_lida_em as Date;
        }
        // No row flipped — either already-read (preserve original) or
        // pagamento missing (throw).
        const existing = await this.db
          .selectFrom('pagamentos')
          .select(['id', 'mensagem_lida_em'])
          .where('id', '=', idPagamento)
          .executeTakeFirst();
        if (existing === undefined) {
          throw new PagamentoNaoEncontradoError(idPagamento);
        }
        if (existing.mensagem_lida_em === null) {
          // Should not happen — guard above missed but the row exists
          // and column is still null. Defensive: persist now.
          await this.db
            .updateTable('pagamentos')
            .set({ mensagem_lida_em: lidaEm })
            .where('id', '=', idPagamento)
            .execute();
          span.setStatus({ code: SpanStatusCode.OK });
          return lidaEm;
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return existing.mensagem_lida_em as Date;
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
   * aperture-16wrk / 5v766 Phase A — batch first-write-wins. Single
   * UPDATE with the full filter set; returns the row-count flipped.
   * Already-read rows skip via `mensagem_lida_em IS NULL`.
   */
  async marcarTodosRecadosLidos(idCampanha: IdCampanha, lidaEm: Date): Promise<number> {
    return tracer.startActiveSpan('db.pagamentos.marcarTodosRecadosLidos', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const result = await this.db
          .updateTable('pagamentos')
          .set({ mensagem_lida_em: lidaEm })
          .where('status', '=', 'aprovado')
          .where('intencao_id_campanha', '=', idCampanha)
          .where('intencao_contribuinte_mensagem', 'is not', null)
          .where(sql`TRIM(intencao_contribuinte_mensagem)`, '<>', '')
          .where('intencao_contribuinte_nome', 'is not', null)
          .where('mensagem_lida_em', 'is', null)
          .executeTakeFirst();
        const flipped =
          typeof result?.numUpdatedRows === 'bigint'
            ? Number(result.numUpdatedRows)
            : (result?.numUpdatedRows ?? 0);
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

// ─── Row <-> aggregate mappers ─────────────────────────────────────

/**
 * Aggregate → row mapper for the `pagamentos` table. Used by save +
 * update. Plan 0016: the aggregate composição columns + the cart-scope
 * id_campanha are sourced from `intencao.composicaoValoresAggregate`;
 * the per-item rows are inserted separately by
 * `insertItemsForPagamento`.
 */
function rowFromPagamento(p: Pagamento): Record<string, unknown> {
  const aggregate = p.intencao.composicaoValoresAggregate;
  return {
    id: p.id,
    status: p.status,
    criado_em: p.criadoEm,
    atualizado_em: p.atualizadoEm,
    intencao_id: p.intencao.id,
    intencao_id_campanha: p.intencao.idCampanha,
    intencao_total_paid_cents: aggregate.totalPaidCents,
    intencao_total_contribution_cents: aggregate.totalContributionCents,
    intencao_total_fee_cents: aggregate.totalFeeCents,
    intencao_total_receiver_cents: aggregate.totalReceiverCents,
    intencao_total_surcharge_cents: aggregate.totalSurchargeCents,
    intencao_metodo: p.intencao.metodo,
    intencao_external_ref: p.intencao.externalRef,
    // aperture-wif8s: webhook-populated provider refs. New rows always
    // start null; update() rewrites them when the handler sets them.
    intencao_payment_intent_external_ref: p.intencao.paymentIntentExternalRef,
    intencao_charge_external_ref: p.intencao.chargeExternalRef,
    // Plan 0015 (aperture-ucgok): contribuinte snapshot persisted on
    // IntencaoPagamento. Null at intent-creation; set by webhook on
    // checkout.session.completed with custom_fields + customer_details.
    intencao_contribuinte_nome: p.intencao.contribuinte?.nome ?? null,
    intencao_contribuinte_email: p.intencao.contribuinte?.email ?? null,
    intencao_contribuinte_mensagem: p.intencao.contribuinte?.mensagem ?? null,
    // Plan 0015 / aperture-mjgxe: when the money becomes available.
    intencao_balance_transaction_available_on: p.intencao.balanceTransactionAvailableOn,
    intencao_criada_em: p.intencao.criadaEm,
    transacao_externa: p.transacaoExterna ? JSON.stringify(p.transacaoExterna) : null,
  };
}

/**
 * Map each ItemDoPagamento to its DB row shape. Insertion order
 * follows the cart's `items` array (caller controls position via the
 * surcharge-LAST convention; the UNIQUE constraint on
 * `(id_pagamento, position)` is the structural enforcement).
 */
function itemRowsFromPagamento(p: Pagamento): Record<string, unknown>[] {
  return p.intencao.items.map((item, position) => {
    if (item.tipo === 'contribuicao') {
      const c = item.composicaoValoresItem;
      return {
        id: item.id,
        id_pagamento: p.id,
        id_intencao_pagamento: p.intencao.id,
        position,
        tipo: 'contribuicao',
        id_contribuicao: item.idContribuicao,
        quantidade: item.quantidade,
        contribution_unit_amount_cents: c.contributionUnitAmountCents,
        fee_unit_amount_cents: c.feeUnitAmountCents,
        receiver_unit_amount_cents: c.receiverUnitAmountCents,
        line_contribution_amount_cents: c.lineContributionAmountCents,
        line_fee_amount_cents: c.lineFeeAmountCents,
        line_receiver_amount_cents: c.lineReceiverAmountCents,
        surcharge_amount_cents: null,
        criado_em: item.criadoEm,
      };
    }
    return {
      id: item.id,
      id_pagamento: p.id,
      id_intencao_pagamento: p.intencao.id,
      position,
      tipo: 'passthrough_surcharge',
      id_contribuicao: null,
      quantidade: 1,
      contribution_unit_amount_cents: null,
      fee_unit_amount_cents: null,
      receiver_unit_amount_cents: null,
      line_contribution_amount_cents: null,
      line_fee_amount_cents: null,
      line_receiver_amount_cents: null,
      surcharge_amount_cents: item.composicaoValoresItem.amountCents,
      criado_em: item.criadoEm,
    };
  });
}

/**
 * Insert all of a pagamento's items inside an open transaction. Caller
 * is responsible for the txn wrapping (so the pagamentos row + items
 * commit/rollback atomically).
 */
async function insertItemsForPagamento(trx: Transaction<DB>, p: Pagamento): Promise<void> {
  const rows = itemRowsFromPagamento(p);
  if (rows.length === 0) return;
  // Cast through unknown to satisfy kysely's `Insertable<intencao_items>`
  // ColumnType-branded shape. The runtime values are correct; the brand
  // is a compile-time guard only.
  await trx
    .insertInto('intencao_items')
    // biome-ignore lint/suspicious/noExplicitAny: kysely Insertable brand vs plain row object
    .values(rows as any)
    .execute();
}

async function loadItemsForPagamento(db: Database, idPagamento: IdPagamento): Promise<ItemRow[]> {
  const rows = await db
    .selectFrom('intencao_items')
    .selectAll()
    .where('id_pagamento', '=', idPagamento)
    .orderBy('position', 'asc')
    .execute();
  return rows as unknown as ItemRow[];
}

/** Map a single item row back to its domain entity. */
function itemFromRow(row: ItemRow): ItemDoPagamento {
  if (row.tipo === 'contribuicao') {
    return ItemDoPagamentoSchema.parse({
      id: row.id,
      tipo: 'contribuicao',
      idContribuicao: row.id_contribuicao,
      quantidade: row.quantidade,
      composicaoValoresItem: {
        tipo: 'contribuicao',
        idContribuicao: row.id_contribuicao,
        quantidade: row.quantidade,
        contributionUnitAmountCents: Number(row.contribution_unit_amount_cents),
        feeUnitAmountCents: Number(row.fee_unit_amount_cents),
        receiverUnitAmountCents: Number(row.receiver_unit_amount_cents),
        lineContributionAmountCents: Number(row.line_contribution_amount_cents),
        lineFeeAmountCents: Number(row.line_fee_amount_cents),
        lineReceiverAmountCents: Number(row.line_receiver_amount_cents),
      },
      criadoEm: row.criado_em,
    });
  }
  return ItemDoPagamentoSchema.parse({
    id: row.id,
    tipo: 'passthrough_surcharge',
    idContribuicao: null,
    quantidade: 1,
    composicaoValoresItem: {
      tipo: 'passthrough_surcharge',
      amountCents: Number(row.surcharge_amount_cents),
    },
    criadoEm: row.criado_em,
  });
}

/**
 * Row → aggregate mapper. Hydrates JSONB columns + revives Date columns
 * + reconstructs the items array from the per-item rows. Parses through
 * PagamentoSchema so any schema drift surfaces as a Zod error at the
 * boundary (vs. silently returning a malformed aggregate).
 */
function pagamentoFromRow(row: PagamentoRow, itemRows: ItemRow[]): Pagamento {
  const transacaoExterna =
    row.transacao_externa == null
      ? undefined
      : typeof row.transacao_externa === 'string'
        ? hydrateTransacaoExterna(JSON.parse(row.transacao_externa))
        : hydrateTransacaoExterna(row.transacao_externa);

  // Plan 0015: rebuild the contribuinte VO from the three columns. All
  // three are nullable at intent-creation; we treat (nome=null, email=null)
  // as "no contribuinte yet" and pass null through. (nome=set, email=set,
  // mensagem=null) is a perfectly valid post-webhook state — Stripe's
  // mensagem custom_field is optional.
  const contribuinte =
    row.intencao_contribuinte_nome !== null && row.intencao_contribuinte_email !== null
      ? {
          nome: row.intencao_contribuinte_nome,
          email: row.intencao_contribuinte_email,
          ...(row.intencao_contribuinte_mensagem !== null
            ? { mensagem: row.intencao_contribuinte_mensagem }
            : {}),
        }
      : null;

  const items = itemRows.map(itemFromRow);

  // Per plan 0016: aggregate composição is reconstructed from the
  // dedicated columns. responsavelTaxa is always 'contribuinte' today;
  // matches the value-object literal.
  const composicaoValoresAggregate = {
    idCampanha: row.intencao_id_campanha,
    totalContributionCents: Number(row.intencao_total_contribution_cents),
    totalFeeCents: Number(row.intencao_total_fee_cents),
    totalReceiverCents: Number(row.intencao_total_receiver_cents),
    totalSurchargeCents: Number(row.intencao_total_surcharge_cents),
    totalPaidCents: Number(row.intencao_total_paid_cents),
    responsavelTaxa: 'contribuinte' as const,
  };

  return PagamentoSchema.parse({
    id: row.id,
    status: row.status,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    intencao: {
      id: row.intencao_id,
      idCampanha: row.intencao_id_campanha,
      items,
      composicaoValoresAggregate,
      metodo: row.intencao_metodo,
      externalRef: row.intencao_external_ref,
      paymentIntentExternalRef: row.intencao_payment_intent_external_ref,
      chargeExternalRef: row.intencao_charge_external_ref,
      contribuinte,
      balanceTransactionAvailableOn: row.intencao_balance_transaction_available_on,
      criadaEm: row.intencao_criada_em,
    },
    transacaoExterna,
  });
}

/**
 * TransacaoExterna.criadaEm needs to be a Date for the Zod schema; JSONB
 * round-trip turns it into an ISO string. Revive it here at the row→domain
 * boundary so the schema parse stays clean.
 */
function hydrateTransacaoExterna(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.criadaEm === 'string') {
    return { ...obj, criadaEm: new Date(obj.criadaEm) };
  }
  return obj;
}
