import { SpanStatusCode } from '@opentelemetry/api';
import type { LivroFinanceiroRepository } from '../../../adapters/pagamentos/financeiro/livro-repository.js';
import type { RepasseJobEnqueuer } from '../../../adapters/pagamentos/transferencia-enqueuer.js';
import type { Observability } from '../../../observability/observability.js';

/**
 * aperture-taacl — periodic sweeper for ORPHANED `verificando` repasses.
 *
 * The executar handler enqueues the confirmar job NON-ATOMICALLY, AFTER the
 * `verificando` FSM commit. A crash in that window strands a repasse in
 * `verificando` with no scheduled confirmar job — it never reconciles (no
 * double-pay risk, but it never reaches pago/falhou either). This sweep closes
 * that hole: it finds `verificando` repasses that have been in that state for
 * more than `minIdadeMinutos` AND have no pending confirmar job, then re-arms
 * the confirmar escalation from tentativa 1.
 *
 * Idempotent + money-safe: confirmar NEVER calls pagarPix (it only observes
 * Inter and resolves the FSM), and its own status='verificando' guard makes a
 * redundant re-enqueue a no-op. The age gate avoids racing a just-committed
 * verificando whose enqueue is milliseconds away; the per-repasse
 * `hasPendingConfirmar` check avoids disturbing a healthy repasse mid-backoff
 * (which legitimately has a job scheduled far in the future).
 */

/** Minimum time a repasse must sit in `verificando` before the sweep re-arms it. */
export const SWEEP_MIN_IDADE_MINUTOS_DEFAULT = 10;

/**
 * Delay (seconds) for the re-armed confirmar poll. Zero — an orphan has been
 * unreconciled for at least `minIdadeMinutos` already, so poll promptly. The
 * escalation restarts from tentativa 1.
 */
const REARM_DELAY_SEGUNDOS = 0;

export interface VarrerRepassesVerificandoOrfaosDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly repasseJobEnqueuer: RepasseJobEnqueuer;
  readonly clock: () => Date;
  readonly observability: Observability;
}

export interface VarrerRepassesVerificandoOrfaosInput {
  /** Overrides {@link SWEEP_MIN_IDADE_MINUTOS_DEFAULT} when supplied. */
  readonly minIdadeMinutos?: number;
}

export interface VarrerRepassesVerificandoOrfaosOutput {
  /** Repasses examined (verificando, older than the age gate). */
  readonly examinados: number;
  /** Repasses re-armed (orphaned — no pending confirmar job). */
  readonly reenfileirados: number;
}

export async function varrerRepassesVerificandoOrfaos(
  deps: VarrerRepassesVerificandoOrfaosDeps,
  input: VarrerRepassesVerificandoOrfaosInput = {},
): Promise<VarrerRepassesVerificandoOrfaosOutput> {
  const { livroFinanceiroRepository, repasseJobEnqueuer, clock, observability } = deps;
  const { logger, tracer } = observability;
  const minIdadeMinutos = input.minIdadeMinutos ?? SWEEP_MIN_IDADE_MINUTOS_DEFAULT;

  return tracer.startActiveSpan('varrerRepassesVerificandoOrfaos', async (span) => {
    span.setAttribute('financeiro.sweep.min_idade_minutos', minIdadeMinutos);
    try {
      const candidatos = await livroFinanceiroRepository.findVerificandoRepassesMaisVelhasQue({
        agora: clock(),
        minIdadeMinutos,
      });
      span.setAttribute('financeiro.sweep.examinados', candidatos.length);

      let reenfileirados = 0;
      for (const idRepasse of candidatos) {
        // Only re-arm a TRUE orphan — a healthy repasse mid-escalation still has
        // a scheduled confirmar job and must not be disturbed.
        const pendente = await repasseJobEnqueuer.hasPendingConfirmar(idRepasse);
        if (pendente) {
          continue;
        }
        await repasseJobEnqueuer.enqueueConfirmar(
          { idRepasse, tentativaConfirmacao: 1 },
          REARM_DELAY_SEGUNDOS,
        );
        reenfileirados += 1;
        logger.warn('financeiro.repasse.sweep.reenfileirado', {
          idRepasse,
          minIdadeMinutos,
        });
      }

      span.setAttribute('financeiro.sweep.reenfileirados', reenfileirados);
      span.setStatus({ code: SpanStatusCode.OK });
      if (reenfileirados > 0) {
        logger.info('financeiro.repasse.sweep.concluido', {
          examinados: candidatos.length,
          reenfileirados,
        });
      }
      return { examinados: candidatos.length, reenfileirados };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
