import { SpanStatusCode } from '@opentelemetry/api';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseJobEnqueuer } from '../../../adapters/pagamentos/transferencia-enqueuer.js';
import type { TransferenciaProvider } from '../../../adapters/pagamentos/transferencia-provider.js';
import type { IdRepasse } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import type { Observability } from '../../../observability/observability.js';

/**
 * Payout confirmation polling was retired by the operator-approved platform
 * handoff contract. The worker remains registered temporarily so already
 * queued `repasse.confirmar` jobs are drained safely after rollout.
 *
 * It deliberately performs no provider call, no state transition, no ledger
 * write and no reschedule. Ambiguous `verificando` records retain their funds
 * and require manual review; an accepted request is finalized directly by the
 * executar worker as `enviado_ao_banco`.
 */

/** Retained only for source compatibility with older tests/callers. No new jobs use it. */
export const MAX_TENTATIVAS_CONFIRMACAO = 12;

/** @deprecated automatic payout confirmation is disabled; always returns null. */
export function proximoDelayConfirmacao(_tentativa: number): null {
  return null;
}

export interface ConfirmarTransferenciaRepasseDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  /** Legacy dependency retained until old queue registrations are removed. Never called here. */
  readonly transferenciaProvider: TransferenciaProvider;
  /** Legacy dependency retained until old queue registrations are removed. Never called here. */
  readonly repasseJobEnqueuer: RepasseJobEnqueuer;
  readonly clock: () => Date;
  readonly observability: Observability;
  readonly extratoVerified: boolean;
}

export interface ConfirmarTransferenciaRepasseInput {
  readonly idRepasse: IdRepasse;
  readonly tentativaConfirmacao: number;
}

export async function confirmarTransferenciaRepasse(
  deps: ConfirmarTransferenciaRepasseDeps,
  input: ConfirmarTransferenciaRepasseInput,
): Promise<void> {
  const { livroFinanceiroRepository, observability } = deps;
  const { logger, tracer } = observability;
  const { idRepasse, tentativaConfirmacao } = input;

  return tracer.startActiveSpan('confirmarTransferenciaRepasse', async (span) => {
    span.setAttribute('financeiro.repasse.id', idRepasse);
    span.setAttribute('financeiro.repasse.tentativa_confirmacao', tentativaConfirmacao);
    try {
      const repasse = await livroFinanceiroRepository.findRepasseById(idRepasse);
      if (!repasse) {
        logger.warn('financeiro.repasse.confirmar.nao_encontrado', { idRepasse });
      } else {
        logger.info('financeiro.repasse.confirmar.desativado', {
          idRepasse,
          status: repasse.status,
        });
      }
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
