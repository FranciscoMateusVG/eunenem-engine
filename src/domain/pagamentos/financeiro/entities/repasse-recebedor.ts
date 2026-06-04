import { z } from 'zod/v4';
import { type IdCampanha, IdCampanhaSchema } from '../../../arrecadacao/value-objects/ids.js';
import { MoneyCentsSchema } from '../../../money.js';
import { type IdRepasse, IdRepasseSchema } from '../value-objects/ids.js';

/**
 * @entity RepasseRecebedor (within the implicit Livro Financeiro aggregate)
 *
 * A payout request initiated by the receiver. Persisted via
 * `LivroFinanceiroRepository.saveRepasse` (and transitioned to `aprovado`
 * via `LivroFinanceiroRepository.aprovarRepasseTransaction` — the
 * approval path is atomic with the bulk lancamento `transferidoEm`
 * stamping).
 *
 * **aperture-s03dr.** FSM extended from 1-state (`solicitado`) to 2-state
 * (`solicitado → aprovado`):
 *
 *   solicitado  — the recebedor has requested a payout; the linked
 *                 lançamentos carry `id_repasse = repasse.id` but
 *                 `transferidoEm IS NULL` (money hasn't moved yet).
 *   aprovado    — the admin has confirmed the bank/PIX transfer;
 *                 the linked lançamentos all have
 *                 `transferidoEm = repasse.aprovadoEm` (atomic with
 *                 the FSM transition). `bankTransferRef` optionally
 *                 carries the bank/PIX confirmation id.
 *
 * The FSM is forward-only. `rejeitado` is intentionally out of scope —
 * if the admin needs to refuse a repasse, the resolution path is an
 * out-of-band conversation; the schema doesn't model it because v1
 * doesn't need to.
 */

export const StatusRepasseSchema = z.enum(['solicitado', 'aprovado']);
export type StatusRepasse = z.infer<typeof StatusRepasseSchema>;

export const RepasseRecebedorSchema = z.object({
  id: IdRepasseSchema,
  idCampanha: IdCampanhaSchema,
  amountCents: MoneyCentsSchema,
  status: StatusRepasseSchema,
  solicitadoEm: z.date(),
  /**
   * Set when the admin transitions the repasse to `aprovado`. Always
   * null while `status === 'solicitado'`. Always set (non-null) while
   * `status === 'aprovado'`. The `aprovarRepasseTransaction` atomic
   * writes this value AND stamps `transferidoEm = aprovadoEm` on every
   * linked lançamento in the same transaction — so the FSM transition
   * and the money-movement record share one timestamp.
   */
  aprovadoEm: z.date().nullable(),
  /**
   * Optional bank-transfer reference the admin can attach at approval
   * time (e.g. a PIX end-to-end id or a TED reference number). Free
   * text — not validated by us; just stored for audit. Null when the
   * admin doesn't supply one.
   */
  bankTransferRef: z.string().nullable(),
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
    aprovadoEm: null,
    bankTransferRef: null,
  };
}

/**
 * Forward-only FSM transition `solicitado → aprovado`.
 *
 * Pure — returns a new entity; does not mutate the input. The use-case
 * layer drives persistence atomically with the bulk lancamento sweep
 * via `LivroFinanceiroRepository.aprovarRepasseTransaction`.
 *
 * Throws `Error` (intentionally untyped at the domain layer — use-case
 * upstream catches and surfaces `FinanceiroRepasseStatusInvalidoError`)
 * if the repasse is not in `solicitado` state. The use-case path also
 * gates this upstream with a typed error; this throw is defense-in-depth
 * for callers that bypass the use-case.
 */
export function aprovarRepasse(
  repasse: RepasseRecebedor,
  bankTransferRef: string | null,
  aprovadoEm: Date,
): RepasseRecebedor {
  if (repasse.status !== 'solicitado') {
    throw new Error(
      `RepasseRecebedor ${repasse.id} cannot transition to 'aprovado' from status '${repasse.status}'.`,
    );
  }
  return {
    ...repasse,
    status: 'aprovado',
    aprovadoEm,
    bankTransferRef,
  };
}
