import type { IdRepasse } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';

/**
 * Raised by `aprovarRepasseRecebedor` when the input idRepasse doesn't
 * resolve to any row in `repasses_recebedor`.
 *
 * tRPC mapping (Track 3): 404 NOT_FOUND.
 */
export class FinanceiroRepasseNaoEncontradoError extends Error {
  readonly name = 'FinanceiroRepasseNaoEncontradoError';

  constructor(public readonly idRepasse: IdRepasse) {
    super(`Repasse "${idRepasse}" not found.`);
  }
}
