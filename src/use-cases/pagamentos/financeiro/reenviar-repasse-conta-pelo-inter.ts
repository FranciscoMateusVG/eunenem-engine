import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseJobEnqueuer } from '../../../adapters/pagamentos/transferencia-enqueuer.js';
import type { RepasseRecebedor } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { IdRepasseSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';
import { FinanceiroRepasseNaoEncontradoError } from '../../../errors/pagamentos/financeiro/repasse-nao-encontrado.error.js';
import { FinanceiroRepasseReenvioInelegivelError } from '../../../errors/pagamentos/financeiro/repasse-reenvio-inelegivel.error.js';
import type { Observability } from '../../../observability/observability.js';
import { gerarTransferReferencia } from './aprovar-repasse-recebedor.js';

/**
 * aperture-mno2s — "Enviar pelo Inter agora". Admin-only, never automatic.
 *
 * For a `conta` repasse that the old manual approval marked transferido
 * although no money was sent (approved, ledger stamped, zero send attempts, no
 * bank reference): un-stamp the ledger and enqueue the real Inter send through
 * the same pipeline new approvals use, atomically, with an audit row (acting
 * admin + motivo). Any attempt or bank reference makes it ineligible, so it
 * cannot double-pay.
 */
export const ReenviarRepasseContaPeloInterInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  motivo: z.string().trim().min(10).max(1000),
  solicitadoPor: z.string().trim().min(1).max(320),
});

export type ReenviarRepasseContaPeloInterInput = Readonly<
  z.infer<typeof ReenviarRepasseContaPeloInterInputSchema>
>;

export interface ReenviarRepasseContaPeloInterDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly repasseJobEnqueuer: RepasseJobEnqueuer;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export async function reenviarRepasseContaPeloInter(
  deps: ReenviarRepasseContaPeloInterDeps,
  input: ReenviarRepasseContaPeloInterInput,
): Promise<{ readonly repasse: RepasseRecebedor; readonly lancamentosDesmarcados: number }> {
  const { livroFinanceiroRepository, repasseJobEnqueuer, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('reenviarRepasseContaPeloInter', async (span) => {
    try {
      const parsed = ReenviarRepasseContaPeloInterInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new FinanceiroInputInvalidoError(
          parsed.error.issues.map((issue) => issue.message).join('; '),
        );
      }
      const { idRepasse, motivo, solicitadoPor } = parsed.data;
      span.setAttribute('financeiro.repasse.id', idRepasse);

      const repasse = await livroFinanceiroRepository.findRepasseById(idRepasse);
      if (!repasse) throw new FinanceiroRepasseNaoEncontradoError(idRepasse);
      const recebedor = await livroFinanceiroRepository.findRecebedorAtivoPorIdCampanha(
        repasse.idCampanha,
      );
      if (recebedor?.metodo !== 'conta') {
        throw new FinanceiroRepasseReenvioInelegivelError(idRepasse, 'recebedor_nao_conta');
      }

      const result = await livroFinanceiroRepository.reenviarRepasseContaPeloInterTransaction(
        {
          idRepasse,
          transferReferencia: gerarTransferReferencia(idRepasse),
          solicitadoPor,
          motivo,
          agora: clock(),
        },
        (executor) => repasseJobEnqueuer.enqueueExecutar({ idRepasse }, executor),
      );

      logger.info('financeiro.repasse.reenvio_inter_autorizado', {
        idRepasse,
        idCampanha: repasse.idCampanha,
        lancamentosDesmarcados: result.lancamentosDesmarcados,
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
