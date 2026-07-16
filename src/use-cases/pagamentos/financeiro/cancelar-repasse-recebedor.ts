import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseRecebedor } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { IdRepasseSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';

/**
 * aperture-vvh2j — Cancelar repasse (admin path). The ONLY claim-release
 * path in the system: transitions a `falhou` repasse to `cancelado`,
 * clearing `id_repasse` on the linked (un-transferred) lançamentos so the
 * funds return to the recebedor's disponivel bucket. The recebedor can
 * then fix a bad chave PIX and re-solicitar a fresh repasse.
 *
 * Only reachable from `falhou` (domain-guarded). A cancelled repasse is
 * terminal and can never be retried. The acting admin is recorded on the
 * audit trail (repasse_transfer_attempts).
 *
 * Admin authorization is enforced upstream (tRPC adminProcedure); this
 * use-case assumes the caller is already authorized.
 */
export const CancelarRepasseRecebedorInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  /** Identifier of the acting admin (e.g. email or user id) — audit trail. */
  canceladoPor: z.string().min(1).max(255),
});

export type CancelarRepasseRecebedorInput = Readonly<
  z.infer<typeof CancelarRepasseRecebedorInputSchema>
>;

export interface CancelarRepasseRecebedorDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: import('../../../observability/observability.js').Observability;
}

export interface CancelarRepasseRecebedorOutput {
  readonly repasse: RepasseRecebedor;
  readonly lancamentosLiberados: number;
}

export async function cancelarRepasseRecebedor(
  deps: CancelarRepasseRecebedorDeps,
  input: CancelarRepasseRecebedorInput,
): Promise<CancelarRepasseRecebedorOutput> {
  const { livroFinanceiroRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('cancelarRepasseRecebedor', async (span) => {
    try {
      const parsed = CancelarRepasseRecebedorInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinanceiroInputInvalidoError(message);
      }
      const { idRepasse, canceladoPor } = parsed.data;
      span.setAttribute('financeiro.repasse.id', idRepasse);

      const result = await livroFinanceiroRepository.cancelarRepasseTransaction({
        idRepasse,
        canceladoPor,
        agora: clock(),
      });

      span.setAttribute('financeiro.repasse.lancamentos_liberados', result.lancamentosLiberados);
      logger.info('financeiro.repasse.cancelado', {
        idRepasse,
        idCampanha: result.repasse.idCampanha,
        lancamentosLiberados: result.lancamentosLiberados,
        canceladoPor,
      });

      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
