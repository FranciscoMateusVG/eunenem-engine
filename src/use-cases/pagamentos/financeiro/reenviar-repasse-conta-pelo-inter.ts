import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseJobEnqueuer } from '../../../adapters/pagamentos/transferencia-enqueuer.js';
import type { TransferenciaProvider } from '../../../adapters/pagamentos/transferencia-provider.js';
import type { RepasseRecebedor } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { IdRepasseSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';
import { FinanceiroRepasseNaoEncontradoError } from '../../../errors/pagamentos/financeiro/repasse-nao-encontrado.error.js';
import { FinanceiroRepasseReenvioInelegivelError } from '../../../errors/pagamentos/financeiro/repasse-reenvio-inelegivel.error.js';
import type { Observability } from '../../../observability/observability.js';
import { gerarTransferReferencia } from './aprovar-repasse-recebedor.js';

const BUSCA_PAGAMENTOS_TIMEOUT_MS = 15_000;

async function comPrazo<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('extrato_timeout')), BUSCA_PAGAMENTOS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * aperture-mno2s — "Enviar pelo Inter agora". Admin-only, never automatic.
 *
 * For a `conta` repasse that the old manual approval marked transferido
 * although no money was sent (approved, ledger stamped, zero send attempts, no
 * bank reference): un-stamp the ledger and enqueue the real Inter send through
 * the same pipeline new approvals use, atomically, with an audit row (acting
 * admin + optional motivo). Any attempt or bank reference makes it ineligible,
 * so it cannot double-pay.
 *
 * aperture-puali — the admin asking to resend IS the authorization: no typed
 * amount, no attestation, and the Inter extrato never blocks. It is exposed
 * separately (`consultarCandidatosReenvio`) as information only.
 */
export const ReenviarRepasseContaPeloInterInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  motivo: z.string().trim().max(1000).optional(),
  solicitadoPor: z.string().trim().min(1).max(320),
});

export type ReenviarRepasseContaPeloInterInput = Readonly<
  z.infer<typeof ReenviarRepasseContaPeloInterInputSchema>
>;

export interface ReenviarRepasseContaPeloInterDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly repasseJobEnqueuer: RepasseJobEnqueuer;
  readonly transferenciaProvider: TransferenciaProvider;
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
        throw new FinanceiroInputInvalidoError('Dados inválidos para reenviar o repasse.');
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
          motivo: motivo ?? '',
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

export interface CandidatoExtratoReenvio {
  readonly e2eId: string | null;
  readonly valorCents: number;
  readonly dataMovimento: string | null;
}

/**
 * Informational only (never blocks a resend): debits in the Inter extrato that
 * look like a hand payment of this repasse. `disponivel: false` when the
 * extrato could not be read.
 */
export async function consultarCandidatosReenvio(
  deps: Pick<
    ReenviarRepasseContaPeloInterDeps,
    'livroFinanceiroRepository' | 'transferenciaProvider' | 'clock'
  >,
  idRepasse: z.infer<typeof IdRepasseSchema>,
): Promise<{
  readonly disponivel: boolean;
  readonly candidatos: readonly CandidatoExtratoReenvio[];
}> {
  const repasse = await deps.livroFinanceiroRepository.findRepasseById(idRepasse);
  if (!repasse) throw new FinanceiroRepasseNaoEncontradoError(idRepasse);
  const recebedor = await deps.livroFinanceiroRepository.findRecebedorAtivoPorIdCampanha(
    repasse.idCampanha,
  );
  if (recebedor?.metodo !== 'conta') return { disponivel: false, candidatos: [] };
  // The old workflow was pay-by-hand THEN approve, so the payment can predate
  // aprovadoEm: start at the solicitação, minus a day (extrato dates are BRT).
  const inicio = new Date(repasse.solicitadoEm.getTime() - 86_400_000);
  const periodo = {
    dataInicio: inicio.toISOString().slice(0, 10),
    dataFim: deps.clock().toISOString().slice(0, 10),
    // A hand payment may have been a TED/transferência, not only a PIX.
    incluirTodosDebitos: true,
  };
  let pagamentos: Awaited<ReturnType<TransferenciaProvider['buscarPagamentos']>>;
  try {
    pagamentos = await comPrazo(deps.transferenciaProvider.buscarPagamentos(periodo));
  } catch {
    return { disponivel: false, candidatos: [] };
  }
  const cpf = recebedor.cpfTitular.replace(/\D/g, '');
  const nome = recebedor.nomeTitular.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const candidatos = pagamentos
    .filter(
      (p) =>
        p.valorCents === repasse.amountCents ||
        p.recipientDocument?.replace(/\D/g, '') === cpf ||
        (p.recipientName !== undefined &&
          p.recipientName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() === nome),
    )
    .map((p) => ({
      e2eId: p.e2eId?.trim() || null,
      valorCents: p.valorCents as number,
      dataMovimento: p.dataMovimento ?? null,
    }));
  return { disponivel: true, candidatos };
}
