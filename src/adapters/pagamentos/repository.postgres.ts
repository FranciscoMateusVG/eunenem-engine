import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Transaction } from 'kysely';
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
import type { PagamentoRepository } from './repository.js';

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
          // biome-ignore lint/suspicious/noExplicitAny: kysely Insertable brand vs plain row object
          await trx.insertInto('pagamentos').values(rowFromPagamento(pagamento) as any).execute();
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

          // Replace items wholesale — items have no independent lifecycle
          // so DELETE-and-INSERT is correct semantics + cheap given the
          // small cardinality (a cart has ≤ a handful of items).
          await trx.deleteFrom('intencao_items').where('id_pagamento', '=', pagamento.id).execute();
          await insertItemsForPagamento(trx, pagamento);
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
    return tracer.startActiveSpan(
      'db.pagamentos.findByPaymentIntentExternalRef',
      async (span) => {
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
      },
    );
  }

  async findByChargeExternalRef(ch: string): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan(
      'db.pagamentos.findByChargeExternalRef',
      async (span) => {
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
      },
    );
  }

  /**
   * Plan 0016 (aperture-aj8qw): post-multi-item the lookup bridges
   * through `intencao_items` — the per-pagamento id_contribuicao column
   * retired in migration 022. Uses the partial index
   * `idx_intencao_items_contribuicao_aprovado` (filter on
   * `id_contribuicao IS NOT NULL`) joined against
   * `pagamentos.status = 'aprovado'`. DISTINCT collapses the
   * (multiple aprovado items pointing at the same contribuição)
   * row-multiplication that the locked decision #6 of plan 0015
   * (accept double-pay) + the multi-cart shape of plan 0016 both make
   * possible.
   *
   * **Phase 2 plan**: this method retires entirely, replaced by
   * `somarQuantidadesContribuicoesEmPagamentosAprovados(ids): Map<…, number>`
   * which returns the sum of `quantidade` per contribuição instead of
   * the binary "any aprovado pagamento?" answer. The new query feeds
   * `quantidadeRestante` directly without a second round-trip.
   */
  async findIdsContribuicoesComPagamentoAprovado(
    idsContribuicao: readonly IdContribuicaoPagamento[],
  ): Promise<readonly IdContribuicaoPagamento[]> {
    return tracer.startActiveSpan(
      'db.pagamentos.findIdsContribuicoesComPagamentoAprovado',
      async (span) => {
        span.setAttributes({
          ...DB_ATTRS,
          'db.operation.name': 'SELECT',
          'batch.size': idsContribuicao.length,
        });
        try {
          if (idsContribuicao.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK });
            return [];
          }
          const rows = await this.db
            .selectFrom('intencao_items')
            .innerJoin('pagamentos', 'pagamentos.id', 'intencao_items.id_pagamento')
            .select('intencao_items.id_contribuicao')
            .distinct()
            .where('pagamentos.status', '=', 'aprovado')
            .where('intencao_items.id_contribuicao', 'in', [...idsContribuicao])
            .execute();
          const result: IdContribuicaoPagamento[] = [];
          for (const r of rows) {
            if (r.id_contribuicao !== null) {
              result.push(r.id_contribuicao as IdContribuicaoPagamento);
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
              row.intencao_contribuinte_nome !== null &&
              row.intencao_contribuinte_email !== null;
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
  // biome-ignore lint/suspicious/noExplicitAny: kysely Insertable brand vs plain row object
  await trx.insertInto('intencao_items').values(rows as any).execute();
}

async function loadItemsForPagamento(
  db: Database,
  idPagamento: IdPagamento,
): Promise<ItemRow[]> {
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
