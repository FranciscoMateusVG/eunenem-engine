import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { ContribuicaoRepository } from '../../adapters/arrecadacao/contribuicao-repository.js';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import {
  type IdContribuicao,
  IdContribuicaoSchema,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { IdContribuicaoPagamento } from '../../domain/pagamentos/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';

/**
 * Plan 0016 Phase 2 (aperture-eg1s2). Pure read query: returns the
 * remaining capacity of a contribuição slot — `contribuicao.quantidade`
 * minus the sum of `quantidade` across all aprovado pagamentos'
 * contribuicao-tipo items that point at this slot.
 *
 * Replaces the pre-0016 `contribuicaoEstaIndisponivel(id): Promise<boolean>`
 * predicate per operator review nit C — pure rename, NO @deprecated
 * alias kept (greenfield staging; no external consumers to migrate).
 *
 * **Overshoot is OK** (locked decision #10): if more items have been
 * sold than the slot's quantidade, the return value is negative.
 * `esgotada()` (sibling) returns `true` in that case. The domain does
 * not prevent overshoot — the operator pockets the extra money, the
 * predicate just surfaces "sold out" + UI shows ESGOTADA.
 *
 * Returns `null` if the contribuição does not exist (caller decides
 * whether that's a 404 or a different error shape).
 *
 * Called by:
 *   - `esgotada` (this file's sibling — UX disclaimer for "is the slot
 *     sold out?" checks).
 *   - `iniciarPagamentoCarrinho` saga (early-fail gate per-item).
 *   - `removerContribuicao` use-case (refuse delete if any aprovado
 *     pagamento referenced this slot — sum > 0).
 *   - admin UI's badge query for the Arrecadação card (N/M count).
 *
 * Locked decision #6 reminder: this is a UX gate, NOT a correctness
 * gate. Two visitors who both pass `esgotada(false)` concurrently both
 * complete payment, both items land aprovado (operator-accepted
 * +money outcome). Locks would defeat the optimistic shape.
 */
export const QuantidadeRestanteInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
});

export type QuantidadeRestanteInput = z.infer<typeof QuantidadeRestanteInputSchema>;

export interface QuantidadeRestanteDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly contribuicaoRepository: ContribuicaoRepository;
  readonly observability: Observability;
}

export async function quantidadeRestante(
  deps: QuantidadeRestanteDeps,
  input: QuantidadeRestanteInput,
): Promise<number | null> {
  const { pagamentoRepository, contribuicaoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('quantidadeRestante', async (span) => {
    try {
      const parsed = QuantidadeRestanteInputSchema.parse(input);
      span.setAttribute('arrecadacao.contribuicao.id', parsed.idContribuicao);

      const contribuicao = await contribuicaoRepository.findById(parsed.idContribuicao);
      if (contribuicao === undefined) {
        span.setStatus({ code: SpanStatusCode.OK });
        return null;
      }

      const sums = await pagamentoRepository.somarQuantidadesContribuicoesEmPagamentosAprovados([
        parsed.idContribuicao as unknown as IdContribuicaoPagamento,
      ]);
      const sold = sums.get(parsed.idContribuicao as unknown as IdContribuicaoPagamento) ?? 0;
      const restante = contribuicao.quantidade - sold;

      span.setAttributes({
        'arrecadacao.contribuicao.quantidade': contribuicao.quantidade,
        'arrecadacao.contribuicao.vendida': sold,
        'arrecadacao.contribuicao.quantidade_restante': restante,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      return restante;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Derived predicate: `quantidadeRestante(c) <= 0`. Returns `false`
 * when the contribuição does not exist (an absent slot is not
 * "sold out"; caller should handle 404 separately).
 *
 * Overshoot returns `true` (e.g. quantidade=5, sold=7 → restante=-2
 * → esgotada). The two-state Phase 4 badge displays the literal
 * word `ESGOTADA` regardless of overshoot magnitude per operator
 * review nit B.
 */
export async function esgotada(
  deps: QuantidadeRestanteDeps,
  input: QuantidadeRestanteInput,
): Promise<boolean> {
  const restante = await quantidadeRestante(deps, input);
  if (restante === null) return false;
  return restante <= 0;
}

// Re-export id types for caller convenience.
export type { IdContribuicao };
