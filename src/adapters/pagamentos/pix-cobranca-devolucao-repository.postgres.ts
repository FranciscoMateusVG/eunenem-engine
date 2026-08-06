import { type Selectable, sql } from 'kysely';
import type { IdPagamento } from '../../domain/pagamentos/value-objects/ids.js';
import type { Database } from '../database.js';
import type { PixCobrancaDevolucoes } from '../db-types.generated.js';
import {
  acquirePaymentMoneyMovementLocks,
  assertRefundCreationAllowed,
} from './payment-money-movement-lock.postgres.js';
import {
  type CreatePixCobrancaDevolucaoInput,
  PixCobrancaDevolucaoConflictError,
  type PixCobrancaDevolucaoIdentity,
  type PixCobrancaDevolucaoRecord,
  type PixCobrancaDevolucaoRepository,
  PixCobrancaDevolucaoStatusSchema,
  parseCreatePixCobrancaDevolucaoInput,
  parsePixCobrancaDevolucaoIdentity,
  parseUpdatePixCobrancaDevolucaoOutcomeInput,
  pixCobrancaDevolucaoBindingMatches,
  type UpdatePixCobrancaDevolucaoOutcomeInput,
} from './pix-cobranca-devolucao-repository.js';

function recordFromRow(row: Selectable<PixCobrancaDevolucoes>): PixCobrancaDevolucaoRecord {
  return {
    id: row.id,
    idPagamento: row.id_pagamento,
    e2eId: row.e2e_id,
    idDevolucao: row.id_devolucao,
    amountCents: Number(row.amount_cents),
    status: PixCobrancaDevolucaoStatusSchema.parse(row.status),
    rtrId: row.rtr_id,
    criadoEm: new Date(row.criado_em),
    atualizadoEm: new Date(row.atualizado_em),
  };
}

export class PixCobrancaDevolucaoRepositoryPostgres implements PixCobrancaDevolucaoRepository {
  constructor(private readonly db: Database) {}

  async createIfAbsent(
    rawInput: CreatePixCobrancaDevolucaoInput,
  ): Promise<{ readonly record: PixCobrancaDevolucaoRecord; readonly created: boolean }> {
    const input = parseCreatePixCobrancaDevolucaoInput(rawInput);
    // biome-ignore lint/suspicious/noExplicitAny: transaction spans generated + raw SQL helpers
    return (this.db as any).transaction().execute(async (tx: any) => {
      await acquirePaymentMoneyMovementLocks(tx, [input.idPagamento]);
      await assertRefundCreationAllowed(tx, input.idPagamento);

      const inserted = await tx
        .insertInto('pix_cobranca_devolucoes')
        .values({
          id: input.id,
          id_pagamento: input.idPagamento,
          e2e_id: input.e2eId,
          id_devolucao: input.idDevolucao,
          amount_cents: input.amountCents,
          status: 'em_processamento',
          rtr_id: null,
          criado_em: input.criadoEm,
          atualizado_em: input.criadoEm,
        })
        // biome-ignore lint/suspicious/noExplicitAny: transaction is intentionally executor-shaped
        .onConflict((conflict: any) => conflict.doNothing())
        .returningAll()
        .executeTakeFirst();

      if (inserted !== undefined) {
        return { record: recordFromRow(inserted), created: true };
      }

      // ON CONFLICT has already waited for any concurrent creator. Read the
      // canonical binding inside this same financial-exclusion transaction.
      const byPayment = await tx
        .selectFrom('pix_cobranca_devolucoes')
        .selectAll()
        .where('id_pagamento', '=', input.idPagamento)
        .executeTakeFirst();
      const byIdentity = await tx
        .selectFrom('pix_cobranca_devolucoes')
        .selectAll()
        .where('e2e_id', '=', input.e2eId)
        .where('id_devolucao', '=', input.idDevolucao)
        .executeTakeFirst();
      const existing = byPayment ?? byIdentity;
      if (existing === undefined) {
        throw new PixCobrancaDevolucaoConflictError();
      }
      const canonical = recordFromRow(existing);
      if (
        !pixCobrancaDevolucaoBindingMatches(canonical, input) ||
        (byPayment !== undefined && byIdentity !== undefined && byPayment.id !== byIdentity.id)
      ) {
        throw new PixCobrancaDevolucaoConflictError();
      }
      return { record: canonical, created: false };
    });
  }

  async findByIdentity(
    e2eId: string,
    idDevolucao: string,
  ): Promise<PixCobrancaDevolucaoRecord | undefined> {
    const input = parsePixCobrancaDevolucaoIdentity(e2eId, idDevolucao);
    const row = await this.db
      .selectFrom('pix_cobranca_devolucoes')
      .selectAll()
      .where('e2e_id', '=', input.e2eId)
      .where('id_devolucao', '=', input.idDevolucao)
      .executeTakeFirst();
    return row === undefined ? undefined : recordFromRow(row);
  }

  async findByPagamentoId(
    idPagamento: IdPagamento,
  ): Promise<PixCobrancaDevolucaoRecord | undefined> {
    const row = await this.db
      .selectFrom('pix_cobranca_devolucoes')
      .selectAll()
      .where('id_pagamento', '=', idPagamento)
      .executeTakeFirst();
    return row === undefined ? undefined : recordFromRow(row);
  }

  async updateOutcome(
    rawInput: UpdatePixCobrancaDevolucaoOutcomeInput,
  ): Promise<PixCobrancaDevolucaoRecord | undefined> {
    const input = parseUpdatePixCobrancaDevolucaoOutcomeInput(rawInput);
    const patch: Record<string, unknown> = {
      status: input.status,
      atualizado_em: sql`GREATEST(atualizado_em, ${input.atualizadoEm})`,
    };
    if (input.rtrId !== undefined) patch.rtr_id = input.rtrId;

    const row = await this.db
      .updateTable('pix_cobranca_devolucoes')
      // biome-ignore lint/suspicious/noExplicitAny: dynamic optional rtr_id patch
      .set(patch as any)
      .where('e2e_id', '=', input.e2eId)
      .where('id_devolucao', '=', input.idDevolucao)
      .where((expression) =>
        expression.or([
          expression('status', '=', 'em_processamento'),
          expression('status', '=', input.status),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) return recordFromRow(row);

    // A terminal state may have won a race while this statement waited.
    // Return it verbatim so the caller converges instead of regressing it.
    return this.findByIdentity(input.e2eId, input.idDevolucao);
  }

  async deleteIfPending(identity: PixCobrancaDevolucaoIdentity): Promise<boolean> {
    const input = parsePixCobrancaDevolucaoIdentity(identity.e2eId, identity.idDevolucao);
    const deleted = await this.db
      .deleteFrom('pix_cobranca_devolucoes')
      .where('e2e_id', '=', input.e2eId)
      .where('id_devolucao', '=', input.idDevolucao)
      .where('status', '=', 'em_processamento')
      .where('rtr_id', 'is', null)
      .executeTakeFirst();
    const count =
      typeof deleted.numDeletedRows === 'bigint'
        ? Number(deleted.numDeletedRows)
        : deleted.numDeletedRows;
    return count > 0;
  }
}
