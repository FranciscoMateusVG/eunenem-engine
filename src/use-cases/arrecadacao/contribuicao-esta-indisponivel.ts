import { SpanStatusCode } from '@opentelemetry/api';
import { z } from 'zod/v4';
import type { PagamentoRepository } from '../../adapters/pagamentos/repository.js';
import { IdContribuicaoSchema } from '../../domain/arrecadacao/value-objects/ids.js';
import type { IdContribuicaoPagamento } from '../../domain/pagamentos/value-objects/ids.js';
import type { Observability } from '../../observability/observability.js';

export const ContribuicaoEstaIndisponivelInputSchema = z.object({
  idContribuicao: IdContribuicaoSchema,
});

export type ContribuicaoEstaIndisponivelInput = z.infer<
  typeof ContribuicaoEstaIndisponivelInputSchema
>;

export interface ContribuicaoEstaIndisponivelDeps {
  readonly pagamentoRepository: PagamentoRepository;
  readonly observability: Observability;
}

/**
 * Plan 0015 (aperture-ucgok). Pure read query: returns `true` when the
 * given contribuição has AT LEAST ONE aprovado pagamento. Replaces the
 * old `contribuicaoDisponivel(contribuicao)` entity-helper that was
 * gone with the status field.
 *
 * Uses the partial index
 * `pagamentos_aprovado_por_contribuicao_idx ON (intencao_id_contribuicao)
 * WHERE status='aprovado'` (migration 019) — sub-millisecond on any
 * realistic data shape.
 *
 * Called by:
 *   - `iniciarPagamentoContribuicao` saga step 2 (UX early-fail gate)
 *   - `removerContribuicao` use-case (refuse delete on slot with aprovado)
 *   - the admin UI's badge query (`/admin/contribuicao/:id` Arrecadação
 *     card — wired in Phase 6)
 *
 * Locked decision #6 reminder: this is a UX gate, NOT a correctness
 * gate. Two visitors who both pass this check concurrently both
 * complete payment, both pagamentos go aprovado (operator-accepted
 * +money outcome). Locks would defeat the optimistic shape.
 */
export async function contribuicaoEstaIndisponivel(
  deps: ContribuicaoEstaIndisponivelDeps,
  input: ContribuicaoEstaIndisponivelInput,
): Promise<boolean> {
  const { pagamentoRepository, observability } = deps;
  const { tracer } = observability;

  return tracer.startActiveSpan('contribuicaoEstaIndisponivel', async (span) => {
    try {
      const parsed = ContribuicaoEstaIndisponivelInputSchema.parse(input);
      span.setAttribute('arrecadacao.contribuicao.id', parsed.idContribuicao);

      const matches = await pagamentoRepository.findIdsContribuicoesComPagamentoAprovado([
        parsed.idContribuicao as unknown as IdContribuicaoPagamento,
      ]);
      const indisponivel = matches.length > 0;
      span.setAttribute('arrecadacao.contribuicao.indisponivel', indisponivel);
      span.setStatus({ code: SpanStatusCode.OK });
      return indisponivel;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}
