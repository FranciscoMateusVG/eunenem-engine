import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseRecebedor } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import { IdRepasseSchema } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';
import { FinanceiroInputInvalidoError } from '../../../errors/pagamentos/financeiro/input-invalido.error.js';

/**
 * aperture-477nz — Admin manual resolution of a `verificando` repasse that the
 * search-reconciliation flagged `needsManualResolution` (one or more candidate
 * payments it could not PROVE were ours, or — while INTER_EXTRATO_VERIFIED is
 * false — a zero-candidate window exhaustion).
 *
 * Two terminal outcomes, each legal ONLY from a `verificando`-flagged repasse
 * (enforced idempotently by the repository transaction — a repasse that already
 * left that state is a no-op returning its current value, which is the
 * concurrency guard against double-resolution):
 *
 *  - `resolverManualPagoRepasse` — the admin CONFIRMED a candidate is ours and
 *    supplies its Inter `codigoSolicitacao`. Books IDENTICALLY to the auto-pago
 *    path: records the codigo, stamps `transferido_em` on the linked lançamentos
 *    (the single §10.1 debit point), appends an audit row with the acting admin.
 *
 *  - `resolverManualFalhouRepasse` — the admin ASSERTS no payment was made.
 *    Transitions to `falhou` (no money moves); from there the admin can retry or
 *    cancelar. Positive assertion, audit-logged.
 *
 * Admin authorization is enforced upstream (tRPC adminProcedure); these
 * use-cases assume the caller is already authorized. `resolvidoPor` is the
 * acting admin's identifier (email), recorded on the audit trail.
 */

/** A fixed, PII-free error string stamped when an admin asserts no payment. */
export const RESOLUCAO_MANUAL_FALHOU_ERRO = 'RESOLUCAO_MANUAL_FALHOU';

export const ResolverManualPagoRepasseInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  /**
   * Inter's server-generated `codigoSolicitacao` for the payment the admin
   * confirmed is ours (copied from the persisted candidate list). This is the
   * ONLY identifier Inter reliably round-trips; the domain records it exactly
   * like the auto-pago path.
   */
  interCodigoSolicitacao: z.string().trim().min(1).max(255),
  /** Identifier of the acting admin (email) — audit trail. */
  resolvidoPor: z.string().min(1).max(255),
});

export type ResolverManualPagoRepasseInput = Readonly<
  z.infer<typeof ResolverManualPagoRepasseInputSchema>
>;

export const ResolverManualFalhouRepasseInputSchema = z.object({
  idRepasse: IdRepasseSchema,
  /** Identifier of the acting admin (email) — audit trail. */
  resolvidoPor: z.string().min(1).max(255),
});

export type ResolverManualFalhouRepasseInput = Readonly<
  z.infer<typeof ResolverManualFalhouRepasseInputSchema>
>;

export interface ResolverManualRepasseDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly clock: () => Date;
  readonly observability: import('../../../observability/observability.js').Observability;
}

export interface ResolverManualRepasseOutput {
  readonly repasse: RepasseRecebedor;
}

export async function resolverManualPagoRepasse(
  deps: ResolverManualRepasseDeps,
  input: ResolverManualPagoRepasseInput,
): Promise<ResolverManualRepasseOutput> {
  const { livroFinanceiroRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('resolverManualPagoRepasse', async (span) => {
    try {
      const parsed = ResolverManualPagoRepasseInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinanceiroInputInvalidoError(message);
      }
      const { idRepasse, interCodigoSolicitacao, resolvidoPor } = parsed.data;
      span.setAttribute('financeiro.repasse.id', idRepasse);

      const result = await livroFinanceiroRepository.resolverManualPagoTransaction({
        idRepasse,
        interCodigoSolicitacao,
        resolvidoPor,
        agora: clock(),
      });

      span.setAttribute('financeiro.repasse.status', result.repasse.status);
      logger.info('financeiro.repasse.resolucao_manual_pago', {
        idRepasse,
        idCampanha: result.repasse.idCampanha,
        status: result.repasse.status,
        resolvidoPor,
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

export async function resolverManualFalhouRepasse(
  deps: ResolverManualRepasseDeps,
  input: ResolverManualFalhouRepasseInput,
): Promise<ResolverManualRepasseOutput> {
  const { livroFinanceiroRepository, clock, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('resolverManualFalhouRepasse', async (span) => {
    try {
      const parsed = ResolverManualFalhouRepasseInputSchema.safeParse(input);
      if (!parsed.success) {
        const message = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new FinanceiroInputInvalidoError(message);
      }
      const { idRepasse, resolvidoPor } = parsed.data;
      span.setAttribute('financeiro.repasse.id', idRepasse);

      const result = await livroFinanceiroRepository.resolverManualFalhouTransaction({
        idRepasse,
        erro: RESOLUCAO_MANUAL_FALHOU_ERRO,
        resolvidoPor,
        agora: clock(),
      });

      span.setAttribute('financeiro.repasse.status', result.repasse.status);
      logger.info('financeiro.repasse.resolucao_manual_falhou', {
        idRepasse,
        idCampanha: result.repasse.idCampanha,
        status: result.repasse.status,
        resolvidoPor,
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
