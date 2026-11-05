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
 * admin + motivo). Any attempt or bank reference makes it ineligible, so it
 * cannot double-pay.
 *
 * An old manual approval could have been paid by hand with the bank reference
 * left blank, so before un-stamping the Inter extrato is checked from the
 * solicitação (minus a day) to today: any debit of the same amount or to the same
 * recipient, or an extrato that cannot be read completely, REFUSES the resend
 * (fail closed). The operator must also re-type the amount and attest they
 * checked the statement.
 */
export const ReenviarRepasseContaPeloInterInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  motivo: z.string().trim().min(10).max(1000),
  solicitadoPor: z.string().trim().min(1).max(320),
  /** The operator re-typed the repasse amount (cents) to prove they looked at it. */
  valorDigitadoCents: z.number().int().positive(),
  /** "Conferi o extrato e este repasse não foi pago por fora." */
  atestado: z.literal(true),
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
        throw new FinanceiroInputInvalidoError(
          parsed.error.issues.map((issue) => issue.message).join('; '),
        );
      }
      const { idRepasse, motivo, solicitadoPor, valorDigitadoCents } = parsed.data;
      span.setAttribute('financeiro.repasse.id', idRepasse);

      const repasse = await livroFinanceiroRepository.findRepasseById(idRepasse);
      if (!repasse) throw new FinanceiroRepasseNaoEncontradoError(idRepasse);
      const recebedor = await livroFinanceiroRepository.findRecebedorAtivoPorIdCampanha(
        repasse.idCampanha,
      );
      if (recebedor?.metodo !== 'conta') {
        throw new FinanceiroRepasseReenvioInelegivelError(idRepasse, 'recebedor_nao_conta');
      }

      if (valorDigitadoCents !== repasse.amountCents) {
        throw new FinanceiroInputInvalidoError(
          'O valor digitado não confere com o valor do repasse.',
        );
      }
      await assertSemPagamentoManualNoExtrato(deps, repasse, recebedor);

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

async function assertSemPagamentoManualNoExtrato(
  deps: ReenviarRepasseContaPeloInterDeps,
  repasse: RepasseRecebedor,
  recebedor: { readonly nomeTitular: string; readonly cpfTitular: string },
): Promise<void> {
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
    throw new FinanceiroRepasseReenvioInelegivelError(repasse.id, 'extrato_inconclusivo');
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
  if (candidatos.length > 0) {
    throw new FinanceiroRepasseReenvioInelegivelError(
      repasse.id,
      'possivel_pagamento_manual',
      candidatos,
    );
  }
}
