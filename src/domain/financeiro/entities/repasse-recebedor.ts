import { z } from 'zod/v4';
import { type IdCampanha, IdCampanhaSchema } from '../../arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../money.js';
import { type IdRepasse, IdRepasseSchema } from '../value-objects/ids.js';

/**
 * @entity RepasseRecebedor (within the implicit Livro Financeiro aggregate)
 *
 * A payout request initiated by the receiver. Today the only supported state
 * is `solicitado` — no real bank/PIX execution yet. Persisted via
 * `LivroFinanceiroRepository.saveRepasse`.
 *
 * `StatusRepasse` is an intrinsic literal VO kept inline (just `'solicitado'`
 * for now; will expand when the state machine grows).
 */

export const StatusRepasseSchema = z.literal('solicitado');
export type StatusRepasse = z.infer<typeof StatusRepasseSchema>;

export const RepasseRecebedorSchema = z.object({
  id: IdRepasseSchema,
  idCampanha: IdCampanhaSchema,
  amountCents: MoneyCentsSchema,
  status: StatusRepasseSchema,
  solicitadoEm: z.date(),
});

export type RepasseRecebedor = Readonly<z.infer<typeof RepasseRecebedorSchema>>;

/** Domain-shaped input para iniciar um repasse. */
export interface SolicitacaoRepasse {
  readonly idRepasse: IdRepasse;
  readonly idCampanha: IdCampanha;
  readonly amountCents: number;
}

export function criarRepasseRecebedorSolicitado(
  input: SolicitacaoRepasse,
  solicitadoEm: Date,
): RepasseRecebedor {
  return {
    id: input.idRepasse,
    idCampanha: input.idCampanha,
    amountCents: input.amountCents,
    status: 'solicitado',
    solicitadoEm,
  };
}
