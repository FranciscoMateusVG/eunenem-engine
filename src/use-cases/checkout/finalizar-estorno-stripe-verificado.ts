import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { StripeRefundOperationRepository } from '../../adapters/pagamentos/stripe-refund-operation-repository.js';
import type { IdPagamento } from '../../domain/pagamentos/value-objects/ids.js';
import { PagamentoEstornoStripeOutcomeDesconhecidoError } from './estorno-pagamento-errors.js';

const VerifiedStripeRefundSchema = z
  .object({
    eventId: z.string().min(1).max(255),
    paymentId: z.string().uuid(),
    chargeRef: z.string().min(1).max(255),
    paymentIntentRef: z.string().min(1).max(255).nullable(),
    amountCents: z.number().int().positive(),
    currency: z.string().regex(/^[a-z]{3}$/),
  })
  .strict();

export async function finalizarEstornoStripeVerificado(
  deps: {
    readonly stripeRefundOperationRepository: StripeRefundOperationRepository;
    readonly clock: () => Date;
  },
  rawInput: z.input<typeof VerifiedStripeRefundSchema>,
): Promise<{ readonly status: 'converged' | 'already_converged' }> {
  const input = VerifiedStripeRefundSchema.parse(rawInput);
  const result = await deps.stripeRefundOperationRepository.observeVerifiedAndConverge({
    ...input,
    paymentId: input.paymentId as IdPagamento,
    operationId: randomUUID(),
    now: deps.clock(),
  });
  if (result.status === 'held_conflict') {
    // The repository has already committed the authoritative provider fact.
    // Throw only after that transaction returned; retries never erase evidence.
    throw new PagamentoEstornoStripeOutcomeDesconhecidoError(input.paymentId);
  }
  return { status: result.status };
}
