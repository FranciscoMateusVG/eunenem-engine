import type { IdContribuicao } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Plan 0015 / aperture-ucgok: a contribuição is "indisponivel" when AT
 * LEAST ONE aprovado pagamento exists for it. Replaces the old
 * `ArrecadacaoContribuicaoNaoDisponivelError` (gone with the status
 * field). The new semantic is **derived from a query** (EXISTS over
 * pagamentos) rather than a stored flag on the aggregate.
 *
 * Thrown by the saga's early-fail gate (`iniciar-pagamento-contribuicao`
 * step 2) when the visitor tries to start a checkout for a slot that
 * already has at least one aprovado pagamento. The webhook's finalize
 * path remains the correctness source of truth — if two visitors both
 * pass this UX gate concurrently, the second one's pagamento still
 * settles to aprovado (operator-accepted +money outcome, plan 0015
 * locked decision #6).
 */
export class ArrecadacaoContribuicaoIndisponivelError extends Error {
  constructor(public readonly idContribuicao: IdContribuicao) {
    super(`Contribuicao indisponivel: ${idContribuicao}`);
    this.name = 'ArrecadacaoContribuicaoIndisponivelError';
  }
}
