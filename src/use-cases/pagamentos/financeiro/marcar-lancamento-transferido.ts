import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { PagamentoRepository } from '../../../adapters/pagamentos/repository.js';
import { IdLancamentoFinanceiroSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import type { IdPagamento } from '../../../domain/pagamentos/value-objects/ids.js';
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
  /**
   * Plan 0015 / aperture-mjgxe. Needed for the derived-liberação gate:
   * each input lançamento resolves to a pagamento; the gate refuses
   * the batch if ANY pagamento is not yet `aprovado AND available_on
   * <= now`.
   */
  readonly pagamentoRepository: PagamentoRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Plan 0015 / aperture-mjgxe. Thrown when the admin tries to transfer
 * lançamentos for a pagamento that is not yet "disponível" (status
 * aprovado AND availableOn <= now). The pagamento is still in the
 * aguardando-liberação sub-state.
 *
 * The HTTP layer maps this to 422 with a operator-readable message
 * "Pagamento ainda em liberação até DD/MM" (per the bead spec).
 * Carries enough context for the message: the offending pagamento id,
 * its current status, its availableOn date (may be null), and a
 * categorical `reason` so the HTTP layer can branch the message
 * without parsing prose.
 */
export class MarcarLancamentoTransferidoBloqueadoError extends Error {
  constructor(
    public readonly idPagamento: string,
    public readonly pagamentoStatus: string,
    public readonly availableOn: Date | null,
    public readonly reason:
      | 'pagamento_nao_aprovado'
      | 'aguardando_liberacao_sem_data'
      | 'aguardando_liberacao_ate',
  ) {
    super(
      `Transfer bloqueado para pagamento ${idPagamento}: ${reason} (status=${pagamentoStatus}, availableOn=${availableOn?.toISOString() ?? 'null'})`,
    );
    this.name = 'MarcarLancamentoTransferidoBloqueadoError';
  }
}

/**
 * Plan 0015 (aperture-ucgok + aperture-mjgxe). Admin-action use-case:
 * stamp `transferidoEm` on a batch of lançamentos to record that the
 * money actually reached the recebedor.
 *
 * **GATE (aperture-mjgxe).** Before stamping, the use-case resolves
 * each input lançamento to its pagamento and verifies the derived
 * liberação predicate is `disponivel`. If ANY pagamento is in
 * aguardando-liberação or non-aprovado, the WHOLE batch is refused
 * with `MarcarLancamentoTransferidoBloqueadoError`. The gate
 * deliberately covers all unique pagamentos in the batch — partial
 * application would leave the admin with a confusing half-state.
 *
 * Idempotency at the row level (preserved from the original
 * ucgok implementation): re-marking an already-transferred row is a
 * silent no-op (adapter WHERE clause skips it). Mix of fresh +
 * already-transferred IDs is acceptable — admin can re-fire the
 * operation without error if a partial batch needs to be retried.
 * Already-cancelled rows (estorno cascade) are also skipped — once
 * a row is `canceladoEm`, the money never left to the recebedor.
 *
 * **v1 ships without an automated banking integration.** This
 * use-case is the admin's manual journal entry that the money path
 * completed. Stripe Connect / open-banking integration is a separate
 * future plan.
 */
export async function marcarLancamentoTransferido(
  deps: MarcarLancamentoTransferidoDeps,
  input: MarcarLancamentoTransferidoInput,
): Promise<MarcarLancamentoTransferidoResult> {
  const { livroFinanceiroRepository, pagamentoRepository, clock, observability } = deps;
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

      // ─── Plan 0015 gate (aperture-mjgxe) ───────────────────────────
      // Resolve unique pagamento ids from the batch + gate-check each.
      const lancamentos = await livroFinanceiroRepository.findLancamentosByIds(idsLancamentos);
      const idsPagamento = new Set<string>(lancamentos.map((l) => l.idPagamento));
      for (const idPagamento of idsPagamento) {
        const pagamento = await pagamentoRepository.findById(idPagamento as IdPagamento);
        if (!pagamento) {
          // Defensive: the lançamento exists but its pagamento doesn't.
          // Treat as gate failure with a clear signal (shouldn't happen
          // outside corrupt-state scenarios; FK enforces this at the DB).
          throw new MarcarLancamentoTransferidoBloqueadoError(
            idPagamento,
            'nao_encontrado',
            null,
            'pagamento_nao_aprovado',
          );
        }
        if (pagamento.status !== 'aprovado') {
          throw new MarcarLancamentoTransferidoBloqueadoError(
            pagamento.id,
            pagamento.status,
            pagamento.intencao.balanceTransactionAvailableOn,
            'pagamento_nao_aprovado',
          );
        }
        const availableOn = pagamento.intencao.balanceTransactionAvailableOn;
        if (availableOn === null) {
          throw new MarcarLancamentoTransferidoBloqueadoError(
            pagamento.id,
            pagamento.status,
            null,
            'aguardando_liberacao_sem_data',
          );
        }
        if (availableOn.getTime() > transferidoEm.getTime()) {
          throw new MarcarLancamentoTransferidoBloqueadoError(
            pagamento.id,
            pagamento.status,
            availableOn,
            'aguardando_liberacao_ate',
          );
        }
      }
      span.setAttribute('financeiro.gate.pagamentos_checked', idsPagamento.size);

      await livroFinanceiroRepository.marcarLancamentosComoTransferidos(
        idsLancamentos,
        transferidoEm,
      );

      logger.info('financeiro.lancamentos.transferidos', {
        batchSize: idsLancamentos.length,
        pagamentosCount: idsPagamento.size,
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
