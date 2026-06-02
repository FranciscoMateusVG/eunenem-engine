import { SpanStatusCode } from '@opentelemetry/api';
import type { LivroFinanceiroRepository } from '../../adapters/financeiro/livro-repository.js';
import type { IdLancamentoFinanceiro } from '../../domain/financeiro/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Maturação de lançamentos pendentes (aperture-led0r, plano 0006).
 *
 * Eager-projection use-case: queries the livro for `pendente`
 * lancamentos with `maturaEm <= now()` and flips them to `disponivel`
 * one by one (per-row UPDATE + per-row audit log).
 *
 * Idempotent: re-running with the same `now` matches zero rows (the
 * first invocation flipped them all to disponivel; the second pass
 * sees nothing pendente+vencido). The adapter's `marcarComoDisponivel`
 * is also idempotent at the row level — calling it on an
 * already-disponivel row is a no-op via WHERE status='pendente'.
 *
 * Cron wiring is OUT OF SCOPE (plano 0005's territory). For v1 the
 * use-case is invokable via:
 *   - manual one-off script (developer triggers locally)
 *   - future admin tRPC procedure (separate bead if operator wants the affordance)
 *   - eventual cron once plano 0005 ships
 *
 * Until plano 0005 ships, the flip is NOT automatic. The admin UI
 * rsidz.6 W5 sharpening §6 already surfaces this gap as an operator
 * affordance line. After led0r ships + plano 0005 ships, the
 * affordance text updates to reflect the live cron.
 */

export interface MaturarLancamentosPendentesDeps {
  readonly livroFinanceiroRepository: LivroFinanceiroRepository;
  readonly observability: Observability;
}

export interface MaturarLancamentosPendentesInput {
  /** The cutoff moment. All pendente rows with maturaEm ≤ this get flipped. */
  readonly agora: Date;
}

export interface MaturarLancamentosPendentesOutput {
  /** Total rows flipped on this invocation (0 when nothing was matured). */
  readonly count: number;
  /** Ids flipped, for downstream audit / event emission. */
  readonly idsMaturados: readonly IdLancamentoFinanceiro[];
}

export async function maturarLancamentosPendentes(
  deps: MaturarLancamentosPendentesDeps,
  input: MaturarLancamentosPendentesInput,
): Promise<MaturarLancamentosPendentesOutput> {
  const { livroFinanceiroRepository, observability } = deps;
  const { logger, tracer } = observability;

  return tracer.startActiveSpan('maturarLancamentosPendentes', async (span) => {
    try {
      span.setAttribute('financeiro.maturacao.agora', input.agora.toISOString());

      const pendentes = await livroFinanceiroRepository.findPendentesMaturos(input.agora);

      if (pendentes.length === 0) {
        logger.info('financeiro.maturacao.nada_a_fazer', { agora: input.agora.toISOString() });
        span.setAttribute('financeiro.maturacao.count', 0);
        span.setStatus({ code: SpanStatusCode.OK });
        return { count: 0, idsMaturados: [] };
      }

      const idsMaturados: IdLancamentoFinanceiro[] = [];
      for (const lancamento of pendentes) {
        await livroFinanceiroRepository.marcarComoDisponivel(lancamento.id);
        logger.info('financeiro.maturacao.lancamento_maturado', {
          idLancamento: lancamento.id,
          idPagamento: lancamento.idPagamento,
          tipo: lancamento.tipo,
          maturaEm: lancamento.maturaEm.toISOString(),
          agora: input.agora.toISOString(),
        });
        idsMaturados.push(lancamento.id);
      }

      span.setAttribute('financeiro.maturacao.count', idsMaturados.length);
      span.setStatus({ code: SpanStatusCode.OK });
      return { count: idsMaturados.length, idsMaturados };
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
