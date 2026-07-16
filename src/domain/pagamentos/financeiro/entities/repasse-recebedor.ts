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
 * **aperture-vvh2j.** FSM extended again for automated PIX-out via Banco
 * Inter. `aprovado` becomes transient for pix recebedores — the admin's
 * approval enqueues the transfer and the worker drives the rest:
 *
 *   solicitado → aprovado → transferindo → pago
 *                                ├→ verificando → pago | falhou
 *                                └→ falhou ──(admin retry)──→ transferindo
 *                                   falhou ──(admin cancel)──→ cancelado
 *
 *   transferindo  — a pagarPix attempt is in flight (intent row committed).
 *   verificando   — a payment MAY exist at Inter and its outcome is
 *                   unknown (timeout / crash / Inter-side APROVACAO). Only
 *                   the reconciliation path leaves this state; NO new
 *                   pagarPix is ever issued from here (double-pay door).
 *   pago          — terminal success. The linked lançamentos are stamped
 *                   `transferidoEm` HERE (aperture-vvh2j moved the stamp
 *                   from approval to pago, so money is never debited from
 *                   the recebedor's balance until the PIX actually lands).
 *   falhou        — confirmed no-money-moved; admin can retry or cancel.
 *   cancelado     — terminal; the ONLY claim-release path. Clears
 *                   id_repasse on the linked lançamentos (funds return to
 *                   the disponivel bucket) so the recebedor can fix a bad
 *                   chave and re-solicitar. A cancelled repasse is never
 *                   retryable.
 *
 * The manual `conta` (bank-coordinate) path is unchanged: it goes
 * `solicitado → aprovado` via `aprovarRepasse` (below) with the money
 * considered sent out-of-band at approval time. Only pix recebedores
 * traverse the transferindo/verificando/pago/falhou/cancelado states.
 *
 * `rejeitado` remains out of scope as a repasse status — a clean Inter
 * rejection lands the repasse in `falhou` (admin-actionable).
 */

export const StatusRepasseSchema = z.enum([
  'solicitado',
  'aprovado',
  'transferindo',
  'verificando',
  'pago',
  'falhou',
  'cancelado',
]);
export type StatusRepasse = z.infer<typeof StatusRepasseSchema>;

/** States a repasse can occupy while its funds are still claimed (id_repasse set) and not yet paid. */
export const STATUS_REPASSE_EM_TRANSITO = [
  'aprovado',
  'transferindo',
  'verificando',
  'falhou',
] as const;

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
   * admin doesn't supply one. Used by the manual `conta` path.
   */
  bankTransferRef: z.string().nullable(),
  /**
   * aperture-vvh2j. Stable reference derived once from the repasse id at
   * approval (pix path), reused across every attempt. NEVER regenerated —
   * this stability is the idempotency anchor that makes retries the SAME
   * payment identity, not a new one. Null for legacy/conta repasses.
   */
  transferReferencia: z.string().nullable(),
  /** Inter's payment id (codigoSolicitacao), set as soon as it is known. */
  interCodigoSolicitacao: z.string().nullable(),
  /** Monotonic attempt counter, incremented on each executar pickup. */
  transferAttempts: z.number().int().nonnegative(),
  /** Operator-facing error detail — Inter error codes only, never PII. */
  lastTransferError: z.string().nullable(),
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
    transferReferencia: null,
    interCodigoSolicitacao: null,
    transferAttempts: 0,
    lastTransferError: null,
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

// ─────────────────────────────────────────────────────────────────────
// aperture-vvh2j — automated PIX transfer FSM transitions.
//
// All pure: return a new entity, never mutate. Each throws on an illegal
// source state (defense-in-depth; the use-case layer gates upstream with
// a typed FinanceiroRepasseStatusInvalidoError). The stable
// `transferReferencia` invariant lives here: it is set exactly once, at
// pix approval, and never rewritten by any later transition.
// ─────────────────────────────────────────────────────────────────────

function assertStatus(
  repasse: RepasseRecebedor,
  permitidos: readonly StatusRepasse[],
  alvo: StatusRepasse,
): void {
  if (!permitidos.includes(repasse.status)) {
    throw new Error(
      `RepasseRecebedor ${repasse.id} cannot transition to '${alvo}' from status '${repasse.status}'.`,
    );
  }
}

/**
 * Pix approval: `solicitado → aprovado`, binding the stable
 * `transferReferencia` that anchors idempotency. Distinct from the manual
 * `aprovarRepasse` above (which serves the `conta` path and sets
 * `bankTransferRef`). The worker picks the repasse up from `aprovado`.
 */
export function aprovarRepassePix(
  repasse: RepasseRecebedor,
  transferReferencia: string,
  aprovadoEm: Date,
): RepasseRecebedor {
  assertStatus(repasse, ['solicitado'], 'aprovado');
  return {
    ...repasse,
    status: 'aprovado',
    aprovadoEm,
    transferReferencia,
  };
}

/**
 * Worker pickup / admin retry: `aprovado | falhou → transferindo`,
 * incrementing the attempt counter. A fresh transfer attempt reuses the
 * SAME `transferReferencia` — it is never regenerated. Clears any prior
 * error. `cancelado`/`pago` are terminal and rejected here (a cancelled
 * repasse can never be retried).
 */
export function iniciarTransferencia(repasse: RepasseRecebedor): RepasseRecebedor {
  assertStatus(repasse, ['aprovado', 'falhou'], 'transferindo');
  if (repasse.transferReferencia === null) {
    throw new Error(
      `RepasseRecebedor ${repasse.id} cannot enter 'transferindo' without a transferReferencia.`,
    );
  }
  return {
    ...repasse,
    status: 'transferindo',
    transferAttempts: repasse.transferAttempts + 1,
    lastTransferError: null,
  };
}

/**
 * Transient reset: `transferindo → aprovado`. Used when a pagarPix attempt
 * failed in a way that DEFINITIVELY created no payment (a
 * TransferenciaTransitoriaError). Reverting to `aprovado` before the job
 * retries makes the re-delivery a clean fresh claim rather than an
 * ambiguous `reconciliar`. Keeps the stable referencia and the (already
 * incremented) attempt counter.
 */
export function reverterTransferenciaParaAprovado(repasse: RepasseRecebedor): RepasseRecebedor {
  assertStatus(repasse, ['transferindo'], 'aprovado');
  return {
    ...repasse,
    status: 'aprovado',
  };
}

/** Terminal success: `transferindo | verificando → pago`, recording Inter's codigoSolicitacao. */
export function marcarRepassePago(
  repasse: RepasseRecebedor,
  interCodigoSolicitacao: string,
): RepasseRecebedor {
  assertStatus(repasse, ['transferindo', 'verificando'], 'pago');
  return {
    ...repasse,
    status: 'pago',
    interCodigoSolicitacao,
    lastTransferError: null,
  };
}

/**
 * Ambiguous outcome: `transferindo → verificando`. A payment MAY exist at
 * Inter (timeout / crash / APROVACAO) and must be positively reconciled.
 * `interCodigoSolicitacao` may be null if we crashed before capturing it.
 * NO pagarPix is ever issued from `verificando` — this is the double-pay door, kept shut.
 */
export function marcarRepasseVerificando(
  repasse: RepasseRecebedor,
  interCodigoSolicitacao: string | null,
): RepasseRecebedor {
  assertStatus(repasse, ['transferindo'], 'verificando');
  return {
    ...repasse,
    status: 'verificando',
    interCodigoSolicitacao: interCodigoSolicitacao ?? repasse.interCodigoSolicitacao,
  };
}

/**
 * Confirmed no-money-moved: `transferindo | verificando → falhou`. Admin
 * can retry (→ transferindo) or cancel (→ cancelado). `erro` carries Inter
 * error codes only — the caller MUST NOT pass PII.
 */
export function marcarRepasseFalhou(repasse: RepasseRecebedor, erro: string): RepasseRecebedor {
  assertStatus(repasse, ['transferindo', 'verificando'], 'falhou');
  return {
    ...repasse,
    status: 'falhou',
    lastTransferError: erro,
  };
}

/**
 * Terminal cancel: `falhou → cancelado`. The ONLY claim-release path.
 * The repository clears `id_repasse` on the linked lançamentos in the
 * same transaction (funds return to the disponivel bucket). A cancelled
 * repasse can never be retried (iniciarTransferencia rejects it).
 */
export function cancelarRepasse(repasse: RepasseRecebedor): RepasseRecebedor {
  assertStatus(repasse, ['falhou'], 'cancelado');
  return {
    ...repasse,
    status: 'cancelado',
  };
}
