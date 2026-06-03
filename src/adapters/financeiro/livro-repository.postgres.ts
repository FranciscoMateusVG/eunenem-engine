import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';
import {
  type LancamentoFinanceiro,
  LancamentoFinanceiroSchema,
} from '../../domain/financeiro/entities/lancamento-financeiro.js';
import {
  type RepasseRecebedor,
  RepasseRecebedorSchema,
} from '../../domain/financeiro/entities/repasse-recebedor.js';
import type { DadosRecebedorAtivo } from '../../domain/financeiro/value-objects/dados-recebedor-ativo.js';
import type {
  IdLancamentoFinanceiro,
  IdPagamentoReferencia,
  IdRepasse,
} from '../../domain/financeiro/value-objects/ids.js';
import { FinanceiroPagamentoJaRegistradoError } from '../../errors/financeiro/pagamento-ja-registrado.error.js';
import type { RecebedorRepository } from '../arrecadacao/recebedor-repository.js';
import type { Database } from '../database.js';
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
};

type RepasseRow = {
  id: string;
  id_campanha: string;
  amount_cents: number;
  status: string;
  solicitado_em: Date;
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
  });
}
