import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import { IdLancamentoFinanceiroSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';
import type { Observability } from '../../../observability/observability.js';

export const MarcarLancamentoTransferidoInputSchema = z.object({
  idsLancamentos: z.array(IdLancamentoFinanceiroSchema).min(1).max(500),
  /**
   * Optional reference to the bank transfer that moved the money.
   * Stored on the audit log; not persisted on the lançamento itself in
   * v1 (the cron / Stripe Connect integration that owns the reference
   * column is out of scope for plan 0015). Operator can paste a
   * `TED-xxx` / `PIX-yyy` reference here for human traceability.
   */
  bankTransferRef: z.string().trim().min(1).max(200).optional(),
});

export type MarcarLancamentoTransferidoInput = z.infer<
  typeof MarcarLancamentoTransferidoInputSchema
>;

export interface MarcarLancamentoTransferidoResult {
  readonly idsLancamentos: readonly string[];
  /**
   * The instant the batch was marked. All rows in the same call share
   * the same timestamp — admin sees a single coherent "transfer event"
   * across the batch.
   */
  readonly transferidoEm: Date;
}

export interface MarcarLancamentoTransferidoDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Plan 0015 (aperture-ucgok). Admin-action use-case: stamp
 * `transferidoEm` on a batch of lançamentos to record that the money
 * actually reached the recebedor. Idempotent at the adapter level:
 * re-marking an already-transferred row is a silent no-op (the
 * WHERE clause skips it). Mix of fresh + already-transferred IDs is
 * acceptable — admin can re-fire the operation without error if a
 * partial batch needs to be retried.
 *
 * Already-cancelled rows (cancelled by an estorno cascade) are also
 * skipped — once a row is `canceladoEm`, the money never left to the
 * recebedor; marking it transferred would be a lie.
 *
 * **v1 ships without an automated banking integration.** This
 * use-case is the admin's manual journal entry that the money path
 * completed. Stripe Connect / open-banking integration is a separate
 * future plan (0014 partially covers — but needs revision per
 * plan 0015's renames).
 */
export async function marcarLancamentoTransferido(
  deps: MarcarLancamentoTransferidoDeps,
  input: MarcarLancamentoTransferidoInput,
): Promise<MarcarLancamentoTransferidoResult> {
  const { livroFinanceiroRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('marcarLancamentoTransferido', async (span) => {
    try {
      const parsed = MarcarLancamentoTransferidoInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join('; ');
        throw new FinanceiroInputInvalidoError(message);
      }

      const { idsLancamentos, bankTransferRef } = parsed.data;
      const transferidoEm = clock();

      span.setAttribute('financeiro.lancamentos.batch_size', idsLancamentos.length);
      if (bankTransferRef) {
        span.setAttribute('financeiro.bank_transfer.ref', bankTransferRef);
      }

      await livroFinanceiroRepository.marcarLancamentosComoTransferidos(
        idsLancamentos,
        transferidoEm,
      );

      logger.info('financeiro.lancamentos.transferidos', {
        batchSize: idsLancamentos.length,
        bankTransferRef: bankTransferRef ?? null,
        transferidoEm: transferidoEm.toISOString(),
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { idsLancamentos, transferidoEm };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
