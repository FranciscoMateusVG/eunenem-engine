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

type LancamentoRow = {
  id: string;
  id_pagamento: string;
  id_contribuicao: string;
  id_campanha: string | null;
  tipo: string;
  amount_cents: number;
  status: string;
  criado_em: Date;
  matura_em: Date;
};

type RepasseRow = {
  id: string;
  id_campanha: string;
  amount_cents: number;
  status: string;
  solicitado_em: Date;
};

/**
 * PostgreSQL adapter for `LivroFinanceiroRepository` (aperture-id3ay).
 * First production wiring of the Financeiro BC — until this lands, every
 * successful checkout's lancamentos went into a Map and disappeared on
 * server restart.
 *
 * Shape decisions:
 *   - `lancamentos_financeiros` and `repasses_recebedor` are two distinct
 *     tables under one adapter (the port's surface is the implicit "livro
 *     financeiro" aggregate).
 *   - `findRecebedorAtivoPorIdCampanha` delegates to the injected
 *     `RecebedorRepository` — recebedor data isn't owned by Financeiro,
 *     it's a cross-BC read from Arrecadação (same as memory adapter).
 *   - Idempotency on (id_pagamento, tipo) is enforced at the DB via the
 *     unique constraint; the adapter catches 23505 and maps it to the
 *     typed `FinanceiroPagamentoJaRegistradoError` (port-conformance).
 *   - The whole-batch INSERT is atomic in Postgres — if either of the
 *     two rows (recebedor + plataforma) collides, neither row lands.
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

        // biome-ignore lint/suspicious/noExplicitAny: Kysely<DB> doesn't know
        // about lancamentos_financeiros until codegen regenerates types.
        await (this.db as any).insertInto('lancamentos_financeiros').values(rows).execute();

        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        if (isUniqueViolation(error, UNIQUE_PAGAMENTO_TIPO)) {
          // Surface the typed error for ALL conflicting idPagamento values
          // in the batch — picking the first matches the memory adapter
          // (it throws on the first collision in its preflight loop).
          // Length-checked above (we returned on empty array), so the
          // non-null assertion is safe.
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

  async findPendentesMaturos(now: Date): Promise<readonly LancamentoFinanceiro[]> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.findPendentesMaturos',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          // aperture-led0r: status='pendente' AND matura_em ≤ now.
          // Postgres uses the partial index
          // `lancamentos_pendentes_maturos_idx ON (matura_em) WHERE
          // status='pendente'` (migration 017) for selective scan.
          // biome-ignore lint/suspicious/noExplicitAny: lancamentos_financeiros not yet in DB types
          const rows = (await (this.db as any)
            .selectFrom('lancamentos_financeiros')
            .selectAll()
            .where('status', '=', 'pendente')
            .where('matura_em', '<=', now)
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

  async marcarComoDisponivel(idLancamento: IdLancamentoFinanceiro): Promise<void> {
    return tracer.startActiveSpan(
      'db.financeiro_livro.lancamentos.marcarComoDisponivel',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
        try {
          // aperture-led0r: idempotent flip — UPDATE matches zero rows
          // when the row is already disponivel (the WHERE clause filters
          // by current status). No exception, no audit-trail noise.
          await sql`
            UPDATE lancamentos_financeiros
              SET status = 'disponivel'
              WHERE id = ${idLancamento}
                AND status = 'pendente'
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
          // Cross-BC delegation — Financeiro doesn't own recebedor data.
          // Memory adapter does the same.
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
    status: l.status,
    criado_em: l.criadoEm,
    matura_em: l.maturaEm,
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
    status: row.status,
    criadoEm: row.criado_em,
    maturaEm: row.matura_em,
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
