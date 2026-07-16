import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseJobEnqueuer } from '../../../adapters/pagamentos/transferencia-enqueuer.js';
import type { RepasseRecebedor } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type { IdRepasse } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { IdRepasseSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';
import { FinanceiroRepasseNaoEncontradoError } from '../../../errors/pagamentos/financeiro/repasse-nao-encontrado.error.js';
import type { Observability } from '../../../observability/observability.js';

/**
 * Stable per-repasse transfer reference — derived deterministically from
 * the repasse id (its 32 hex chars, dashes stripped). Generated once at
 * approval and reused across every attempt; the determinism means even an
 * accidental regeneration yields the identical value. The real Inter
 * adapter (aperture-ju5w2) maps this onto Inter's txid format.
 */
export function gerarTransferReferencia(idRepasse: IdRepasse): string {
  return `EN${String(idRepasse).replace(/-/g, '')}`;
}

/**
 * aperture-s03dr. Aprovar repasse — admin path. Transitions a pending
 * (`solicitado`) repasse to `aprovado`, atomically stamping
 * `transferidoEm = aprovadoEm` on every linked + un-transferred
 * lançamento. After this call returns, the recebedor's
 * valorDisponivelCents (the calcularSaldoRecebedor projection over
 * transferidoEm IS NOT NULL rows) increases by `repasse.amountCents`
 * and the parent campanha unblocks for a new solicitação.
 *
 * Idempotency: re-approving an already-aprovado repasse with the SAME
 * `bankTransferRef` is a no-op (returns the existing repasse,
 * lancamentosAfetados=0). Re-approving with a DIFFERENT
 * `bankTransferRef` throws `FinanceiroRepasseStatusInvalidoError` —
 * audit values don't get silently overwritten.
 *
 * The use-case does NOT enforce any admin gate (that's tRPC's job in
 * Track 3). It assumes the caller has already authorized the operator.
 */
export const AprovarRepasseRecebedorInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  /**
   * Optional bank/PIX transfer reference (e.g. PIX end-to-end id, TED
   * confirmation). Free text — not validated by us; stored as audit
   * trail on the repasse + visible to admin + recebedor in the extrato.
   * Null when the admin doesn't supply one.
   */
  bankTransferRef: z.string().min(1).max(255).nullable().default(null),
});

export type AprovarRepasseRecebedorInput = Readonly<
  z.infer<typeof AprovarRepasseRecebedorInputSchema>
>;

export interface AprovarRepasseRecebedorDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly repasseJobEnqueuer: RepasseJobEnqueuer;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface AprovarRepasseRecebedorOutput {
  readonly repasse: RepasseRecebedor;
  readonly lancamentosAfetados: number;
}

export async function aprovarRepasseRecebedor(
  deps: AprovarRepasseRecebedorDeps,
  input: AprovarRepasseRecebedorInput,
): Promise<AprovarRepasseRecebedorOutput> {
  const { livroFinanceiroRepository, repasseJobEnqueuer, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('aprovarRepasseRecebedor', async (span) => {
    try {
      const parsed = AprovarRepasseRecebedorInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinanceiroInputInvalidoError(message);
      }

      const { idRepasse, bankTransferRef } = parsed.data;
      const aprovadoEm = clock();

      span.setAttribute('financeiro.repasse.id', idRepasse);
      span.setAttribute('financeiro.repasse.bank_transfer_ref.set', bankTransferRef !== null);

      // Determine the payout method: PIX recebedores get the automated
      // transfer (approve = pay, async via pg-boss); `conta` (bank
      // coordinate) recebedores keep the existing manual bankTransferRef
      // path. metodo is stable — the branch decision is re-validated under
      // FOR UPDATE inside whichever transaction runs.
      const repasse = await livroFinanceiroRepository.findRepasseById(idRepasse);
      if (!repasse) {
        throw new FinanceiroRepasseNaoEncontradoError(idRepasse);
      }
      const recebedor = await livroFinanceiroRepository.findRecebedorAtivoPorIdCampanha(
        repasse.idCampanha,
      );

      if (recebedor?.metodo === 'pix') {
        const transferReferencia = gerarTransferReferencia(idRepasse);
        span.setAttribute('financeiro.repasse.metodo', 'pix');

        // Transactional enqueue — the executar job is inserted inside the
        // same DB transaction as the FSM transition to `aprovado`. Approve
        // rollback ⇒ no job; enqueue failure ⇒ approve rolls back.
        const pixResult = await livroFinanceiroRepository.aprovarRepassePixTransaction(
          { idRepasse, aprovadoEm, transferReferencia },
          (executor) => repasseJobEnqueuer.enqueueExecutar({ idRepasse }, executor),
        );

        logger.info('financeiro.repasse.aprovado_pix', {
          idRepasse,
          idCampanha: pixResult.repasse.idCampanha,
          amountCents: pixResult.repasse.amountCents,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        // No lançamentos stamped at approval for pix — the debit books at `pago`.
        return { repasse: pixResult.repasse, lancamentosAfetados: 0 };
      }

      // Manual path (conta, or no active recebedor): unchanged behavior —
      // stamps transferido_em at approval and records bankTransferRef.
      span.setAttribute('financeiro.repasse.metodo', recebedor?.metodo ?? 'desconhecido');
      const result = await livroFinanceiroRepository.aprovarRepasseTransaction({
        idRepasse,
        aprovadoEm,
        bankTransferRef,
      });

      span.setAttribute('financeiro.repasse.lancamentos_afetados', result.lancamentosAfetados);

      logger.info('financeiro.repasse.aprovado', {
        idRepasse,
        idCampanha: result.repasse.idCampanha,
        amountCents: result.repasse.amountCents,
        lancamentosAfetados: result.lancamentosAfetados,
        bankTransferRef,
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
