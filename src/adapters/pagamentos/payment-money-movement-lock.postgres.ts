import { sql } from 'kysely';
import { FinanceiroPagamentoMovimentacaoConflitanteError } from '../../errors/pagamentos/financeiro/pagamento-movimentacao-conflitante.error.js';
import { sortUniquePaymentIds } from './payment-money-movement-lock.js';

// Kysely's transaction/executor structural type is intentionally wider than
// the generated Database type. Keeping this helper executor-shaped lets both
// finance and refund adapters use the exact same lock implementation.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous Kysely transaction executor
type SqlExecutor = any;

export const BLOCKING_PIX_REFUND_STATUSES = ['em_processamento', 'devolvida'] as const;
export const BLOCKING_REPASSE_STATUSES = ['transferindo', 'verificando', 'pago'] as const;

/**
 * Transaction-scoped, per-payment exclusion lock. IDs are sorted before
 * acquisition so batches cannot deadlock each other in opposite input order.
 * PostgreSQL's hashtextextended is deterministic for the same UUID text.
 */
export async function acquirePaymentMoneyMovementLocks(
  executor: SqlExecutor,
  idsPagamento: readonly string[],
): Promise<readonly string[]> {
  const sorted = sortUniquePaymentIds(idsPagamento);
  for (const idPagamento of sorted) {
    await sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${idPagamento}::text, 0))
    `.execute(executor);
  }
  return sorted;
}

export async function assertRefundCreationAllowed(
  executor: SqlExecutor,
  idPagamento: string,
): Promise<void> {
  const result = (await sql<{ blocked: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM lancamentos_financeiros l
        LEFT JOIN repasses_recebedor r ON r.id = l.id_repasse
        WHERE l.id_pagamento = ${idPagamento}
          AND (
            l.transferido_em IS NOT NULL
            OR r.status = ANY(${[...BLOCKING_REPASSE_STATUSES]}::text[])
          )
    ) AS blocked
  `.execute(executor)) as unknown as { rows: Array<{ blocked: boolean }> };
  if (result.rows[0]?.blocked === true) {
    throw new FinanceiroPagamentoMovimentacaoConflitanteError(idPagamento, 'devolucao');
  }
}

export async function assertTransfersAllowed(
  executor: SqlExecutor,
  idsPagamento: readonly string[],
): Promise<void> {
  if (idsPagamento.length === 0) return;
  const result = (await sql<{ id_pagamento: string }>`
    SELECT id_pagamento
      FROM pix_cobranca_devolucoes
      WHERE id_pagamento = ANY(${[...idsPagamento]}::uuid[])
        AND status = ANY(${[...BLOCKING_PIX_REFUND_STATUSES]}::text[])
      ORDER BY id_pagamento ASC
      LIMIT 1
  `.execute(executor)) as unknown as { rows: Array<{ id_pagamento: string }> };
  const blocked = result.rows[0]?.id_pagamento;
  if (blocked !== undefined) {
    throw new FinanceiroPagamentoMovimentacaoConflitanteError(blocked, 'transferencia');
  }
}

export async function findPaymentIdsForLancamentos(
  executor: SqlExecutor,
  idsLancamentos: readonly string[],
): Promise<readonly string[]> {
  if (idsLancamentos.length === 0) return [];
  const result = (await sql<{ id_pagamento: string }>`
    SELECT DISTINCT id_pagamento
      FROM lancamentos_financeiros
      WHERE id = ANY(${[...idsLancamentos]}::uuid[])
      ORDER BY id_pagamento ASC
  `.execute(executor)) as unknown as { rows: Array<{ id_pagamento: string }> };
  return result.rows.map((row) => row.id_pagamento);
}

export async function findPaymentIdsForRepasse(
  executor: SqlExecutor,
  idRepasse: string,
): Promise<readonly string[]> {
  const result = (await sql<{ id_pagamento: string }>`
    SELECT DISTINCT id_pagamento
      FROM lancamentos_financeiros
      WHERE id_repasse = ${idRepasse}
      ORDER BY id_pagamento ASC
  `.execute(executor)) as unknown as { rows: Array<{ id_pagamento: string }> };
  return result.rows.map((row) => row.id_pagamento);
}
