import { z } from "zod";
import type { LancamentoFinanceiro } from "../../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js";
import type {
  RepasseRecebedor,
  StatusRepasse,
} from "../../../../src/domain/pagamentos/financeiro/entities/repasse-recebedor.js";
import type { Pagamento } from "../../../../src/domain/pagamentos/entities/pagamento.js";

/**
 * Projeção pura de estados do extrato (aperture-5jk8y, pré-requisito do
 * plano aperture-owmqs §6 / A1).
 *
 * Extraído SEM mudança de comportamento de `server/trpc/recebedor-router.ts`
 * (csye7 / aperture-1ut92 / aperture-2u5vw) para que o extrato do usuário e o
 * detalhe financeiro do admin compartilhem exatamente a mesma projeção e
 * nunca divirjam. Nenhuma função aqui faz I/O: entram entidades já
 * carregadas, sai um estado derivado.
 */

/** Forma projetada de um movimento OUT (repasse). Espelha MovimentacaoDTOSchema do router. */
export interface MovimentacaoProjetada {
  idRepasse: string;
  solicitadoEm: string;
  concluidoEm: string | null;
  enviadoAoBancoEm: string | null;
  valorCents: number;
  quantidade: number;
  tipo: "transferencia_conta";
  estado: MovimentoRepasseEstado;
  statusRepasse: StatusRepasse | null;
}

/**
 * aperture-1ut92 — derived liberação predicate per row.
 *
 *   - `aguardando_liberacao` — aprovado pagamento, availableOn in the
 *     future (or null while webhook hasn't populated it yet).
 *   - `disponivel` — aprovado + availableOn <= now AND not yet claimed
 *     by a repasse. The ONLY actionable state for SOLICITAR.
 *   - `solicitado` — claimed by a solicitado repasse
 *     (lancamento.idRepasse !== null) but admin hasn't approved yet
 *     (transferidoEm still null). Money is in the admin pipeline.
 *   - `enviado_ao_banco` — Inter accepted the payout request. This is
 *     platform-complete and included in resgatadoCents.
 *   - `transferido` — admin approved the repasse (transferidoEm set).
 *     The terminal happy-path state.
 *   - `cancelado` — pagamento estornado; lancamento.canceladoEm set.
 *     Excluded from extrato totals (refund posture).
 *
 * Precedence when multiple predicates could fire (defensive ordering):
 *   cancelado > transferido > solicitado > disponivel > aguardando_liberacao
 * The terminal states (cancelado/transferido) dominate; solicitado
 * dominates disponivel because once idRepasse is set the row is no
 * longer actionable for a fresh SOLICITAR.
 */
export const ExtratoLiberacaoSchema = z.enum([
  "aguardando_liberacao",
  "disponivel",
  "solicitado",
  "enviado_ao_banco",
  "transferido",
  "cancelado",
]);
export type ExtratoLiberacao = z.infer<typeof ExtratoLiberacaoSchema>;

export const MovimentoRepasseEstadoSchema = z.enum([
  "aguardando_aprovacao",
  "em_transferencia",
  "enviado_ao_banco",
  "concluido",
  "falhou",
  "cancelado",
  "inconsistente",
]);

export interface ExtratoLancamentoState {
  lancamento: LancamentoFinanceiro;
  pagamento: Pagamento | undefined;
  /**
   * aperture-k6fbz — gift name + image for THIS lançamento.
   *
   * aperture-sm7uc (#6 fix): resolved via `lancamento.idContribuicao`
   * (Plan 0016 Phase 2 / migration 023 — each lançamento carries the
   * NOT-NULL FK to its own contribuição), NOT via the first cart item.
   * The previous "first contribuição-tipo item" projection collapsed
   * every row in a multi-item cart to the same name and image, which
   * surfaced in prod as the painel extrato showing "Fralda Ecológica"
   * three times when the cart actually held three different items.
   *
   * Undefined when the contribuição has been deleted between the
   * pagamento + the read. Row projection falls back to a neutral
   * empty-string/null shape in that case.
   */
  contribuicao: { nome: string; imagemUrl: string | null } | undefined;
  liberacao: ExtratoLiberacao;
}

const ACTIVE_PENDING_REPASSE_STATUSES = new Set<StatusRepasse>([
  "solicitado",
  "aprovado",
  "transferindo",
  "verificando",
]);

export function isActivePendingRepasse(status: StatusRepasse | undefined): boolean {
  return status !== undefined && ACTIVE_PENDING_REPASSE_STATUSES.has(status);
}

export type MovimentoRepasseEstado = z.infer<typeof MovimentoRepasseEstadoSchema>;

export interface RepasseLedgerGroup {
  valorTransferidoCents: number;
  quantidade: number;
  concluidoEm: Date | null;
}

export function projectRepasseEstado(
  // Só `status` e `amountCents` são lidos; aceitar o subconjunto permite
  // projetar a partir de linhas SQL do admin (aperture-5jk8y) sem
  // reidratar a entidade. Comportamento idêntico.
  repasse: Pick<RepasseRecebedor, "status" | "amountCents">,
  ledger: RepasseLedgerGroup | undefined,
): MovimentoRepasseEstado {
  if (ledger?.concluidoEm) {
    return ledger.valorTransferidoCents === (repasse.amountCents as unknown as number)
      ? "concluido"
      : "inconsistente";
  }
  switch (repasse.status) {
    case "solicitado":
      return "aguardando_aprovacao";
    case "aprovado":
    case "transferindo":
    case "verificando":
      return "em_transferencia";
    case "enviado_ao_banco":
      return "enviado_ao_banco";
    case "falhou":
      return "falhou";
    case "cancelado":
      return "cancelado";
    case "pago":
      // A paid PIX repasse and its ledger transfer stamp are committed in
      // the same transaction. Do not invent a completed movement if those
      // two authoritative records disagree.
      return "inconsistente";
  }
}

export function buildMovimentacoes(
  repasses: readonly RepasseRecebedor[],
  states: readonly ExtratoLancamentoState[],
): MovimentacaoProjetada[] {
  const ledgerByRepasse = new Map<string, RepasseLedgerGroup>();
  for (const state of states) {
    const idRepasse = state.lancamento.idRepasse;
    if (idRepasse === null) continue;
    const key = idRepasse as unknown as string;
    const existing = ledgerByRepasse.get(key) ?? {
      valorTransferidoCents: 0,
      quantidade: 0,
      concluidoEm: null,
    };
    existing.quantidade += 1;
    if (state.lancamento.transferidoEm !== null) {
      existing.valorTransferidoCents += state.lancamento.amountCents as unknown as number;
      existing.concluidoEm =
        existing.concluidoEm === null ||
        state.lancamento.transferidoEm.getTime() < existing.concluidoEm.getTime()
          ? state.lancamento.transferidoEm
          : existing.concluidoEm;
    }
    ledgerByRepasse.set(key, existing);
  }

  const knownRepasseIds = new Set(repasses.map((repasse) => repasse.id as unknown as string));
  const result: MovimentacaoProjetada[] = repasses.map((repasse) => {
    const key = repasse.id as unknown as string;
    const ledger = ledgerByRepasse.get(key);
    return {
      idRepasse: key,
      solicitadoEm: repasse.solicitadoEm.toISOString(),
      concluidoEm: ledger?.concluidoEm?.toISOString() ?? null,
      enviadoAoBancoEm: repasse.enviadoAoBancoEm?.toISOString() ?? null,
      valorCents: repasse.amountCents as unknown as number,
      quantidade: ledger?.quantidade ?? 0,
      tipo: "transferencia_conta" as const,
      estado: projectRepasseEstado(repasse, ledger),
      statusRepasse: repasse.status,
    };
  });

  // Compatibility: preserve transferred ledger groups whose historical
  // repasse record is unavailable. They were the only rows emitted by the
  // previous endpoint and must not disappear or duplicate during rollout.
  for (const [idRepasse, ledger] of ledgerByRepasse) {
    if (knownRepasseIds.has(idRepasse) || ledger.concluidoEm === null) continue;
    result.push({
      idRepasse,
      solicitadoEm: ledger.concluidoEm.toISOString(),
      concluidoEm: ledger.concluidoEm.toISOString(),
      enviadoAoBancoEm: null,
      valorCents: ledger.valorTransferidoCents,
      quantidade: ledger.quantidade,
      tipo: "transferencia_conta",
      estado: "concluido",
      statusRepasse: null,
    });
  }

  return result.sort((a, b) => {
    if (a.solicitadoEm !== b.solicitadoEm) {
      return a.solicitadoEm < b.solicitadoEm ? 1 : -1;
    }
    return a.idRepasse.localeCompare(b.idRepasse);
  });
}

export function deriveLiberacao(
  l: LancamentoFinanceiro,
  p: Pagamento | undefined,
  now: Date,
): ExtratoLiberacao {
  // Precedence: terminal states first, then admin-pipeline, then liquid,
  // then locked. See ExtratoLiberacaoSchema docblock.
  if (l.canceladoEm !== null) return "cancelado";
  if (l.transferidoEm !== null) return "transferido";
  // aperture-1ut92 — idRepasse set but transferidoEm still null →
  // claimed by a solicitado repasse, awaiting admin approval. Same
  // pagamento.status invariant as disponivel (lancamento can only be
  // claimed if its parent pagamento is aprovado), so we skip the
  // status guard here.
  if (l.idRepasse !== null) return "solicitado";
  if (!p) return "aguardando_liberacao";
  if (p.status !== "aprovado") return "aguardando_liberacao";
  const availableOn = p.intencao.balanceTransactionAvailableOn;
  if (availableOn === null || availableOn === undefined) return "aguardando_liberacao";
  return availableOn.getTime() <= now.getTime() ? "disponivel" : "aguardando_liberacao";
}

export function applyRepasseLiberacao(
  states: readonly ExtratoLancamentoState[],
  repasses: readonly RepasseRecebedor[],
): ExtratoLancamentoState[] {
  const statusById = new Map(
    repasses.map((repasse) => [repasse.id as unknown as string, repasse.status]),
  );
  return states.map((state) => {
    const idRepasse = state.lancamento.idRepasse;
    if (
      idRepasse !== null &&
      statusById.get(idRepasse as unknown as string) === "enviado_ao_banco"
    ) {
      return { ...state, liberacao: "enviado_ao_banco" };
    }
    return state;
  });
}
