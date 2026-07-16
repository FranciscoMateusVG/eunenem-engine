import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseJobEnqueuer } from '../../../adapters/pagamentos/transferencia-enqueuer.js';
import type { RepasseRecebedor } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { IdRepasseSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';
import { FinanceiroRepasseNaoEncontradoError } from '../../../errors/pagamentos/financeiro/repasse-nao-encontrado.error.js';
import { FinanceiroRepasseStatusInvalidoError } from '../../../errors/pagamentos/financeiro/repasse-status-invalido.error.js';
import type { Observability } from '../../../observability/observability.js';

/**
 * aperture-vvh2j — Admin retry of a `falhou` pix repasse. Re-enqueues the
 * executar job (non-transactional — there is no surrounding write); the
 * executar handler's iniciar moves falhou → transferindo with a fresh
 * attempt, reusing the SAME stable transferReferencia. Only a `falhou`
 * repasse is retryable; anything else (incl. `cancelado`) is rejected.
 *
 * Admin authorization is enforced upstream (tRPC adminProcedure).
 */
export const RetentarTransferenciaRepasseInputSchema = z.object({
  idRepasse: IdRepasseSchema,
});

export type RetentarTransferenciaRepasseInput = Readonly<
  z.infer<typeof RetentarTransferenciaRepasseInputSchema>
>;

export interface RetentarTransferenciaRepasseDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly repasseJobEnqueuer: RepasseJobEnqueuer;
  readonly observability: Observability;
}

export interface RetentarTransferenciaRepasseOutput {
  readonly repasse: RepasseRecebedor;
}

export async function retentarTransferenciaRepasse(
  deps: RetentarTransferenciaRepasseDeps,
  input: RetentarTransferenciaRepasseInput,
): Promise<RetentarTransferenciaRepasseOutput> {
  const { livroFinanceiroRepository, repasseJobEnqueuer, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('retentarTransferenciaRepasse', async (span) => {
    try {
      const parsed = RetentarTransferenciaRepasseInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinanceiroInputInvalidoError(message);
      }
      const { idRepasse } = parsed.data;
      span.setAttribute('financeiro.repasse.id', idRepasse);

      const repasse = await livroFinanceiroRepository.findRepasseById(idRepasse);
      if (!repasse) {
        throw new FinanceiroRepasseNaoEncontradoError(idRepasse);
      }
      // Retry is only valid from falhou — the one state we KNOW no money moved.
      if (repasse.status !== 'falhou') {
        throw new FinanceiroRepasseStatusInvalidoError(idRepasse, repasse.status);
      }

      await repasseJobEnqueuer.enqueueExecutar({ idRepasse });

      logger.info('financeiro.repasse.retry_enfileirado', {
        idRepasse,
        idCampanha: repasse.idCampanha,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return { repasse };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
