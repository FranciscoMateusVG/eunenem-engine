import { SpanStatusCode, trace } from '@opentelemetry/api';
import { type Pagamento, PagamentoSchema } from '../../domain/pagamentos/entities/pagamento.js';
import type {
  IdContribuicaoPagamento,
  IdPagamento,
} from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentoJaExisteError } from '../../errors/pagamentos/ja-existe.error.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import type { Database } from '../database.js';
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

type PagamentoRow = {
  id: string;
  status: string;
  criado_em: Date;
  atualizado_em: Date;
  intencao_id: string;
  intencao_id_contribuicao: string;
  intencao_amount_cents: number;
  intencao_metodo: string;
  // JSONB columns surface as `unknown` from kysely-codegen until we ship
  // typed schemas. The hydration step parses them through PagamentoSchema
  // which enforces the shape end-to-end.
  intencao_composicao_valores: unknown;
  intencao_external_ref: string | null;
  // aperture-wif8s: pi_xxx + ch_xxx provider refs populated by the
  // webhook handler post-aprovado. Both nullable; partial indexes on
  // each WHERE NOT NULL via migration 018.
  intencao_payment_intent_external_ref: string | null;
  intencao_charge_external_ref: string | null;
  // Plan 0015 / aperture-ucgok / migration 019: contribuinte columns
  // populated by the webhook at checkout.session.completed (Stripe
  // custom_fields). All nullable at intent-creation; flipped to the
  // visitor's data when the webhook fires.
  intencao_contribuinte_nome: string | null;
  intencao_contribuinte_email: string | null;
  intencao_contribuinte_mensagem: string | null;
  // Plan 0015 / aperture-mjgxe / migration 020: when the visitor's money
  // becomes available to the recebedor. PIX = NOW() set inline by
  // dispatcher at pi.succeeded; cartão = Stripe API
  // charge.balance_transaction.available_on. Nullable.
  intencao_balance_transaction_available_on: Date | null;
  intencao_criada_em: Date;
  transacao_externa: unknown;
};

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
 * production wiring of the Pagamento BC — until this lands, only the
 * in-memory adapter exists.
 *
 * Shape decisions:
 *   - The IntencaoPagamento embedded entity is FLATTENED into top-level
 *     columns (intencao_*) for lookup-by-field convenience (e.g. the
 *     external_ref + id_contribuicao indexes). The TransacaoExterna
 *     embedded entity stays as a single JSONB column — it's never queried
 *     by inner field and only loaded with the aggregate root.
 *   - composicao_valores stays JSONB (deep, snapshot-style — never queried
 *     by inner field).
 *   - Save/update insert/replace the full aggregate atomically — no field-
 *     level patch surface.
 */
export class PagamentoRepositoryPostgres implements PagamentoRepository {
  constructor(private readonly db: Database) {}

  async save(pagamento: Pagamento): Promise<void> {
    return tracer.startActiveSpan('db.pagamentos.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        // biome-ignore lint/suspicious/noExplicitAny: Kysely<unknown> + JSONB columns
        await (this.db as any)
          .insertInto('pagamentos')
          .values(rowFromPagamento(pagamento))
          .execute();
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
        // biome-ignore lint/suspicious/noExplicitAny: Kysely<unknown> + JSONB columns
        const result = await (this.db as any)
          .updateTable('pagamentos')
          .set(rowFromPagamento(pagamento))
          .where('id', '=', pagamento.id)
          .executeTakeFirst();

        // Match memory-adapter semantics: throw when no row was matched
        // (caller treated this as "must exist"). Kysely returns a result
        // object with numUpdatedRows; cast to bigint-aware number compare.
        const matched =
          typeof result?.numUpdatedRows === 'bigint'
            ? Number(result.numUpdatedRows)
            : (result?.numUpdatedRows ?? 0);
        if (matched === 0) {
          throw new PagamentoNaoEncontradoError(pagamento.id);
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

  async findById(id: IdPagamento): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan('db.pagamentos.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        // biome-ignore lint/suspicious/noExplicitAny: see save()
        const row = (await (this.db as any)
          .selectFrom('pagamentos')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst()) as PagamentoRow | undefined;
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? pagamentoFromRow(row) : undefined;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByContribuicao(idContribuicao: IdContribuicaoPagamento): Promise<readonly Pagamento[]> {
    return tracer.startActiveSpan('db.pagamentos.findByContribuicao', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        // The pagamentos_intencao_id_contribuicao_idx (migration 011)
        // makes this an indexed scan even on a large table.
        // biome-ignore lint/suspicious/noExplicitAny: see save()
        const rows = (await (this.db as any)
          .selectFrom('pagamentos')
          .selectAll()
          .where('intencao_id_contribuicao', '=', idContribuicao)
          .orderBy('criado_em', 'asc')
          .execute()) as PagamentoRow[];
        const result = rows.map(pagamentoFromRow);
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

  async findByExternalRef(externalRef: string): Promise<Pagamento | undefined> {
    return tracer.startActiveSpan('db.pagamentos.findByExternalRef', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        // biome-ignore lint/suspicious/noExplicitAny: see save()
        const row = (await (this.db as any)
          .selectFrom('pagamentos')
          .selectAll()
          .where('intencao_external_ref', '=', externalRef)
          .executeTakeFirst()) as PagamentoRow | undefined;
        span.setStatus({ code: SpanStatusCode.OK });
        return row ? pagamentoFromRow(row) : undefined;
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
          // biome-ignore lint/suspicious/noExplicitAny: see save()
          const row = (await (this.db as any)
            .selectFrom('pagamentos')
            .selectAll()
            .where('intencao_payment_intent_external_ref', '=', pi)
            .executeTakeFirst()) as PagamentoRow | undefined;
          span.setStatus({ code: SpanStatusCode.OK });
          return row ? pagamentoFromRow(row) : undefined;
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
          // biome-ignore lint/suspicious/noExplicitAny: see save()
          const row = (await (this.db as any)
            .selectFrom('pagamentos')
            .selectAll()
            .where('intencao_charge_external_ref', '=', ch)
            .executeTakeFirst()) as PagamentoRow | undefined;
          span.setStatus({ code: SpanStatusCode.OK });
          return row ? pagamentoFromRow(row) : undefined;
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
          // Uses partial index
          // `pagamentos_aprovado_por_contribuicao_idx ON
          // (intencao_id_contribuicao) WHERE status='aprovado'`
          // (migration 019). One indexed scan over the candidate set.
          // DISTINCT collapses the (multiple aprovado pagamentos per
          // contribuição) row-multiplication that the locked decision
          // #6 of plan 0015 (accept double-pay) makes possible.
          // biome-ignore lint/suspicious/noExplicitAny: see save()
          const rows = (await (this.db as any)
            .selectFrom('pagamentos')
            .select('intencao_id_contribuicao')
            .distinct()
            .where('status', '=', 'aprovado')
            .where('intencao_id_contribuicao', 'in', [...idsContribuicao])
            .execute()) as Array<{ intencao_id_contribuicao: string }>;
          const result = rows.map(
            (r) => r.intencao_id_contribuicao as IdContribuicaoPagamento,
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
}

/** Aggregate → row mapper. Used by save + update. */
function rowFromPagamento(p: Pagamento): Record<string, unknown> {
  return {
    id: p.id,
    status: p.status,
    criado_em: p.criadoEm,
    atualizado_em: p.atualizadoEm,
    intencao_id: p.intencao.id,
    intencao_id_contribuicao: p.intencao.idContribuicao,
    intencao_amount_cents: p.intencao.amountCents,
    intencao_metodo: p.intencao.metodo,
    intencao_composicao_valores: JSON.stringify(p.intencao.composicaoValores),
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
 * Row → aggregate mapper. Hydrates JSONB columns + revives Date columns.
 * Parses through PagamentoSchema so any schema drift surfaces as a Zod
 * error at the boundary (vs. silently returning a malformed aggregate).
 */
function pagamentoFromRow(row: PagamentoRow): Pagamento {
  // Postgres returns JSONB as parsed JS objects through the node-postgres
  // driver, but defensively handle the case where it arrives as a string
  // (older driver versions / type coercion).
  const composicaoValores =
    typeof row.intencao_composicao_valores === 'string'
      ? JSON.parse(row.intencao_composicao_valores)
      : row.intencao_composicao_valores;

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

  return PagamentoSchema.parse({
    id: row.id,
    status: row.status,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    intencao: {
      id: row.intencao_id,
      idContribuicao: row.intencao_id_contribuicao,
      amountCents: row.intencao_amount_cents,
      metodo: row.intencao_metodo,
      composicaoValores,
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
