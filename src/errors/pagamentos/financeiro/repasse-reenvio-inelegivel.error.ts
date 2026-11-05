import type { IdRepasse } from '../../../domain/pagamentos/financeiro/value-objects/ids.js';

export type MotivoReenvioInelegivel =
  | 'nao_aprovado'
  | 'recebedor_nao_conta'
  | 'ja_enviado_ou_tentado'
  | 'referencia_bancaria_registrada'
  | 'possivel_pagamento_manual'
  | 'extrato_inconclusivo';

/** Extrato debit that blocked a resend — E2E id, amount and date only (no PII). */
export interface CandidatoPagamentoManual {
  readonly e2eId: string | null;
  readonly valorCents: number;
  readonly dataMovimento: string | null;
}

/**
 * Raised by `reenviarRepasseContaPeloInter` when the repasse is not in the one
 * state the action exists for: a `conta` repasse approved by the old manual
 * path (ledger stamped transferido) with no send attempt and no bank reference.
 */
export class FinanceiroRepasseReenvioInelegivelError extends Error {
  readonly name = 'FinanceiroRepasseReenvioInelegivelError';

  constructor(
    public readonly idRepasse: IdRepasse,
    public readonly motivo: MotivoReenvioInelegivel,
    public readonly candidatos: readonly CandidatoPagamentoManual[] = [],
  ) {
    super(`Repasse "${idRepasse}" is not eligible for resend through Inter: ${motivo}.`);
  }
}
