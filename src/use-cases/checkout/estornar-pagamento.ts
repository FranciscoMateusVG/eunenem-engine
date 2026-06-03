import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../adapters/financeiro/livro-repository.js';
import type { PagamentoEventPublisher } from '../../adapters/pagamentos/event-publisher.js';
import type { PagamentoProvider } from '../../adapters/pagamentos/provider.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import {
  estornarPagamentoAprovado,
  type Pagamento,
} from '../../domain/pagamentos/entities/pagamento.js';
import { IdPagamentoSchema } from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentoNaoEncontradoError } from '../../errors/pagamentos/nao-encontrado.error.js';
import { PagamentoTransicaoStatusInvalidaError } from '../../errors/pagamentos/transicao-status-invalida.error.js';
import type { Observability } from '../../observability/observability.js';

export const EstornarPagamentoInputSchema = z.object({
  idPagamento: IdPagamentoSchema,
  /**
   * Optional reason for the refund. Threaded to the provider's refund
   * call (Stripe's `reason` field). Defaults to `requested_by_customer`
   * when unset (provider-side default also).
   */
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
});

export type EstornarPagamentoInput = z.infer<typeof EstornarPagamentoInputSchema>;

export interface EstornarPagamentoResult {
  readonly pagamento: Pagamento;
  readonly refundId: string;
}

/**
 * Thrown when the admin tries to estornar a pagamento that has at least
 * one already-transferred lançamento. Once the money has reached the
 * recebedor it can't be clawed back through this path — disputes /
 * chargebacks would have to follow the (out-of-scope) disputes flow.
 *
 * HTTP layer maps this to 409 Conflict (locked decision #10 of plan 0015).
 */
export class PagamentoEstornoLancamentoJaTransferidoError extends Error {
  constructor(public readonly idPagamento: string) {
    super(
      `Estorno bloqueado: pelo menos um lancamento financeiro deste pagamento ja foi transferido ao recebedor. idPagamento=${idPagamento}`,
    );
    this.name = 'PagamentoEstornoLancamentoJaTransferidoError';
  }
}

/**
 * Thrown when the provider's refund call returns `recusado`. Surfaces
 * upstream so the admin sees why the estorno failed (and the pagamento
 * stays `aprovado` — no partial state).
 */
export class PagamentoEstornoRecusadoPeloProvedorError extends Error {
  constructor(
    public readonly idPagamento: string,
    public readonly statusBruto: string | undefined,
  ) {
    super(
      `Provedor recusou o estorno do pagamento ${idPagamento} (status bruto: ${statusBruto ?? 'desconhecido'}).`,
    );
    this.name = 'PagamentoEstornoRecusadoPeloProvedorError';
  }
}

export interface EstornarPagamentoDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly pagamentoProvider: PagamentoProvider;
  readonly pagamentoEventPublisher: PagamentoEventPublisher;
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: Observability;
}

/**
 * Plan 0015 (aperture-ucgok). Admin-action use-case: estorno an aprovado
 * pagamento. Five-step orchestration:
 *
 *   1. Load + validate the pagamento is `aprovado` (the entity
 *      transition is `aprovado → estornado`; any other source state
 *      throws PagamentoTransicaoStatusInvalidaError).
 *   2. Pre-transfer gate: ask the financeiro module whether any
 *      lançamento on this pagamento has `transferidoEm IS NOT NULL`.
 *      If yes → 409 (locked decision #10). The money has already
 *      reached the recebedor; the refund path is closed.
 *   3. Fire the provider's refund call. Provider returns `aceito`
 *      (money path committed) or `recusado` (surface upstream;
 *      pagamento stays aprovado).
 *   4. Transition pagamento → estornado in the domain; update repo.
 *   5. Cascade `canceladoEm` onto every untransferred lançamento for
 *      this pagamento (the financeiro adapter's WHERE clause
 *      enforces this defensively — but step 2's gate already
 *      guarantees no transferred rows exist).
 *
 * **NOT atomic across BCs in v1.** Step 3 (provider) and steps 4–5
 * (DB) happen in sequence. If the provider returns `aceito` and
 * step 4 fails, the money is refunded but our state still says
 * aprovado — the next admin retry hits the idempotent fact that
 * the provider already refunded (Stripe deduplicates via the
 * idempotency-key in `pagamento:{id}:refund`), so the use-case
 * can be re-run safely without double-refunding. A proper
 * outbox/saga around this is a follow-up bead.
 *
 * **Idempotency contract:** invoking on an already-estornado
 * pagamento returns the existing state without re-firing the
 * provider call.
 */
export async function estornarPagamento(
  deps: EstornarPagamentoDeps,
  input: EstornarPagamentoInput,
): Promise<EstornarPagamentoResult> {
  const {
    pagamentoRepository,
    pagamentoProvider,
    livroFinanceiroRepository,
    clock,
    observability,
  } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('estornarPagamento', async (span) => {
    try {
      const parsed = EstornarPagamentoInputSchema.parse(input);
      span.setAttribute('checkout.pagamento.id', parsed.idPagamento);
      if (parsed.reason) {
        span.setAttribute('refund.reason', parsed.reason);
      }

      // step 1: load + validate
      const pagamento = await pagamentoRepository.findById(parsed.idPagamento);
      if (!pagamento) {
        throw new PagamentoNaoEncontradoError(parsed.idPagamento);
      }
      if (pagamento.status === 'estornado') {
        // Idempotent: already estornado. Return the existing snapshot.
        // The refundId is unknowable at this point (we didn't fire the
        // provider call); emit a synthetic "replay" marker so callers
        // can distinguish from a first-run.
        logger.info('checkout.pagamento.replay_estorno', {
          idPagamento: pagamento.id,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return { pagamento, refundId: 'replay' };
      }
      if (pagamento.status !== 'aprovado') {
        throw new PagamentoTransicaoStatusInvalidaError(
          pagamento.id,
          pagamento.status,
          'estornado',
        );
      }

      // step 2: 409 gate — has ANY lançamento on this pagamento been
      // transferred to the recebedor? If yes, refuse.
      const hasTransferidos = await livroFinanceiroRepository.hasLancamentosTransferidos(
        pagamento.id,
      );
      if (hasTransferidos) {
        throw new PagamentoEstornoLancamentoJaTransferidoError(pagamento.id);
      }

      // step 3: fire the provider's refund call.
      const refundResult = await pagamentoProvider.refundarPagamento({
        idPagamento: pagamento.id,
        chargeExternalRef: pagamento.intencao.chargeExternalRef,
        paymentIntentExternalRef: pagamento.intencao.paymentIntentExternalRef,
        amountCents: pagamento.intencao.amountCents,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
      });
      if (refundResult.status === 'recusado') {
        throw new PagamentoEstornoRecusadoPeloProvedorError(
          pagamento.id,
          refundResult.statusBruto,
        );
      }
      span.setAttribute('refund.id', refundResult.id);

      // step 4: transition pagamento → estornado (domain) + persist.
      const now = clock();
      const estornado = estornarPagamentoAprovado(pagamento, now);
      await pagamentoRepository.update(estornado);

      // step 5: cascade canceladoEm on the untransferred lançamentos.
      // The adapter's WHERE clause is defense-in-depth — step 2's gate
      // guarantees zero already-transferred rows could match here.
      await livroFinanceiroRepository.marcarLancamentosComoCanceladosPorPagamento(
        pagamento.id,
        now,
      );

      logger.info('checkout.pagamento.estornado', {
        idPagamento: pagamento.id,
        idContribuicao: pagamento.intencao.idContribuicao,
        amountCents: pagamento.intencao.amountCents,
        refundId: refundResult.id,
        refundReason: parsed.reason ?? 'requested_by_customer',
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { pagamento: estornado, refundId: refundResult.id };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
