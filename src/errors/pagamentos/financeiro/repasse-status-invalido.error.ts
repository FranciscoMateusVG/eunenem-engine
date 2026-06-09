import type { StatusRepasse } from '../../../domain/pagamentos/financeiro/entities/repasse-recebedor.js';
import type { IdRepasse } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';

/**
 * Raised by `aprovarRepasseRecebedor` when the target repasse is not in
 * the `solicitado` state — i.e. it's already `aprovado`. The use-case is
 * idempotent at the SAME terminal state (re-approving an already-aprovado
 * repasse short-circuits to a no-op success); this error fires only on
 * a SHAPE that doesn't fit the transition.
 *
 * Today the only non-solicitado state is `aprovado`, so this error
 * effectively signals "already aprovado, but the input would mutate
 * bankTransferRef or aprovadoEm" — surfaced as 409 by Track 3.
 *
 * Reserved for future FSM expansions (e.g. a `rejeitado` state would
 * land here on an aprovar attempt).
 */
export class FinanceiroRepasseStatusInvalidoError extends Error {
  readonly name = 'FinanceiroRepasseStatusInvalidoError';

  constructor(
    public readonly idRepasse: IdRepasse,
    public readonly statusAtual: StatusRepasse,
  ) {
    super(
      `Repasse "${idRepasse}" cannot be aprovado from status '${statusAtual}'. ` +
        `Only 'solicitado' repasses can be approved.`,
    );
  }
}
