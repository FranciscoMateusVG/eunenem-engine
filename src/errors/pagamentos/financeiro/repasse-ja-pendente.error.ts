import type { IdCampanha } from '../../../domain/arrecadacao/value-objects/ids.js';

/**
 * Raised when a `solicitarRepasseRecebedor` call hits the unique partial
 * index `repasses_um_solicitado_por_campanha` — at most ONE pending
 * (status='solicitado') repasse per campanha at a time. Surfaced by the
 * postgres adapter as a 23505 catch on the constraint name; surfaced by
 * the memory adapter via preflight check.
 *
 * tRPC mapping (Track 2 / Track 3): 409 CONFLICT.
 */
export class FinanceiroRepasseJaPendenteError extends Error {
  readonly name = 'FinanceiroRepasseJaPendenteError';

  constructor(public readonly idCampanha: IdCampanha) {
    super(
      `Campanha "${idCampanha}" already has a pending repasse (status='solicitado'). ` +
        `Wait for it to be aprovado before solicitando another.`,
    );
  }
}
