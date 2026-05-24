import type { IdContribuicao } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Raised by `desassociarContribuinteContribuicao` when the target contribuição
 * is already `disponivel` — typically because the compensation ran twice or
 * the caller is racing two checkouts. The orchestrator should treat this as
 * "nothing to do" and continue (idempotency signal), not bubble it up.
 */
export class ArrecadacaoContribuicaoJaDisponivelError extends Error {
  public readonly code = 'ARRECADACAO_CONTRIBUICAO_JA_DISPONIVEL' as const;

  constructor(public readonly idContribuicao: IdContribuicao) {
    super(`Contribuicao ja esta disponivel: ${idContribuicao}`);
    this.name = 'ArrecadacaoContribuicaoJaDisponivelError';
  }
}
