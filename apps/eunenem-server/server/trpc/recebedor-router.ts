/**
 * Recebedor tRPC router — aperture-7g5sx (Track 2 of aperture-q2d4b).
 *
 * Powers the painel EXTRATO surface for the campanha owner. Three
 * procedures:
 *
 *   1. extrato.summary({ idCampanha })
 *      Header KPIs: totalRecebido / resgatado / saldoDisponivel /
 *      aguardandoLiberacao / proximaTransfDate / totalPresentes /
 *      dateRangeStart / dateRangeEnd.
 *
 *   2. extrato.list({ idCampanha, statusFilters, cursor, limit })
 *      Per-contribuição rows for the extrato table with liberacao
 *      derived predicate + contribuinte attribution from the parent
 *      pagamento.intencao.
 *
 *   3. transferencia.solicitar({ idCampanha })
 *      Wraps Track 1's solicitarRepasseRecebedor use-case. Sweeps
 *      every currently-disponivel lançamento atomically.
 *
 * AUTH MODEL: the "recebedor" identity here is the campanha owner —
 * a user whose `idConta` is in `campanha.idsAdministradores`. The auth
 * cookie chain matches the contribuicao-router pattern: session token
 * → usuario lookup → campanha membership check. Wrong-tenant access
 * surfaces UNAUTHORIZED (not NOT_FOUND — don't leak existence).
 *
 * V1 PERFORMANCE NOTE: the summary + list paths do in-router cross-port
 * composition (lançamentos × pagamentos lookups). For prod-scale
 * recebedor extratos this should move into a single SQL aggregation on
 * the postgres adapter. v1 is bounded small (campanha contribuições are
 * tens, not thousands) — defer the SQL optimization until needed.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Campanha } from "../../../../src/domain/arrecadacao/entities/campanha.js";
import type {
  IdCampanha,
  IdConta,
} from "../../../../src/domain/arrecadacao/value-objects/ids.js";
import type { LancamentoFinanceiro } from "../../../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js";
import type { Pagamento } from "../../../../src/domain/pagamentos/entities/pagamento.js";
import { randomUUID } from "node:crypto";
import {
  ArrecadacaoCampanhaNaoEncontradaError,
  ArrecadacaoInputInvalidoError,
  ArrecadacaoNaoAutorizadoError,
  ArrecadacaoRecebedorJaExisteError,
  CheckoutRecebedorNaoPagavelViaPixError,
  criarRecebedorParaCampanha,
  CriarRecebedorParaCampanhaInputSchema,
  FinanceiroRepasseJaPendenteError,
  FinanceiroSaldoDisponivelInsuficienteError,
  FinanceiroInputInvalidoError,
  solicitarRepasseRecebedor,
} from "../../../../src/index.js";
import type { TrpcContext } from "./context.js";

const t = initTRPC.context<TrpcContext>().create();

/** Wire shape: header KPI card on the painel extrato view. */
const ExtratoSummaryDTOSchema = z.object({
  /** Sum of all aprovado + not-cancelled saldo_recebedor lançamentos. */
  totalRecebidoCents: z.number().int().nonnegative(),
  /** Already-withdrawn: transferidoEm IS NOT NULL. */
  resgatadoCents: z.number().int().nonnegative(),
  /**
   * Currently withdrawable: aprovado + availableOn <= now + not-yet
   * claimed by any repasse + not-transferred + not-cancelled.
   *
   * aperture-1ut92 — solicitado lançamentos (idRepasse !== null but
   * transferidoEm still null) are NOW EXCLUDED from this bucket. They
   * still count toward totalRecebido but live under the new
   * aguardandoAprovacaoCents sibling field. Operator's mental model:
   * "this is the saldo I can SOLICITAR on right now" — solicitado
   * cents are in the admin pipeline, not actionable.
   */
  saldoDisponivelCents: z.number().int().nonnegative(),
  /**
   * aperture-1ut92 — sum of lançamentos already claimed by a
   * solicitado repasse but not yet approved by admin. These cents are
   * in flight; once admin approves, they roll into resgatadoCents.
   * Surfaces a 3rd bucket on the header so the operator sees the
   * full lifecycle: aguardando_liberacao → disponivel → solicitado
   * (this) → resgatado.
   */
  aguardandoAprovacaoCents: z.number().int().nonnegative(),
  /** Aprovado but not-yet-liberado: status='aprovado' AND availableOn > now. */
  aguardandoLiberacaoCents: z.number().int().nonnegative(),
  /** Earliest upcoming availableOn (ISO). Null when nothing aguardando. */
  proximaTransfDate: z.string().nullable(),
  /** Distinct pagamentos contributing to totalRecebido. */
  totalPresentes: z.number().int().nonnegative(),
  /**
   * aperture-kvpvf — finishes the B1 audit. Distinct aprovado
   * pagamentos in this campanha whose `intencao.contribuinte` has BOTH
   * a non-null nome AND a non-empty (trimmed) mensagem. Mirrors B3's
   * `MuralRecadoProjection` predicate exactly — same eligibility, just
   * COUNT instead of project. Powers the painel home 3-col strip's
   * "RECADOS" cell (was mocked at 12).
   *
   * Counted from `liveStates` here so the same lançamento walk that
   * already drives every other summary metric stays the single source
   * of truth (no extra DB roundtrip).
   */
  totalRecadosCount: z.number().int().nonnegative(),
  /**
   * aperture-kvpvf — finishes the B1 audit. Count of
   * `ItemDoPagamento` rows of `tipo='contribuicao'` whose parent
   * pagamento is aprovado on the current campanha. ONE PER CART ITEM
   * (a 5-item cart contributes 5), NOT one per pagamento — distinct
   * from `totalPresentes` above which is the distinct-pagamento count
   * used by the featured "presentes recebidos" card. This field powers
   * the painel home 3-col strip's "PRESENTES" cell (was mocked at 2).
   *
   * Cancelado lançamentos already filtered out via `liveStates`.
   * passthrough_surcharge items are skipped — those are platform
   * surcharges, not gifts.
   */
  totalPresentesItensCount: z.number().int().nonnegative(),
  /** Earliest contribution date (ISO). Null when no contributions. */
  dateRangeStart: z.string().nullable(),
  /** Latest contribution date (ISO). Null when no contributions. */
  dateRangeEnd: z.string().nullable(),
});
export type ExtratoSummaryDTO = z.infer<typeof ExtratoSummaryDTOSchema>;

/**
 * aperture-1ut92 — 5-state derived liberação predicate per row.
 *
 *   - `aguardando_liberacao` — aprovado pagamento, availableOn in the
 *     future (or null while webhook hasn't populated it yet).
 *   - `disponivel` — aprovado + availableOn <= now AND not yet claimed
 *     by a repasse. The ONLY actionable state for SOLICITAR.
 *   - `solicitado` — claimed by a solicitado repasse
 *     (lancamento.idRepasse !== null) but admin hasn't approved yet
 *     (transferidoEm still null). Money is in the admin pipeline.
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
const ExtratoLiberacaoSchema = z.enum([
  "aguardando_liberacao",
  "disponivel",
  "solicitado",
  "transferido",
  "cancelado",
]);
export type ExtratoLiberacao = z.infer<typeof ExtratoLiberacaoSchema>;

/** Wire shape: one row in the painel extrato table. */
const ExtratoRowDTOSchema = z.object({
  idLancamento: z.string(),
  idPagamento: z.string(),
  /**
   * Contribuinte name from `pagamento.intencao.contribuinte.nome`.
   * Null on anonymous OR pre-Phase-3 rows.
   */
  contribuinteNome: z.string().nullable(),
  /**
   * aperture-k6fbz — the gift (contribuição) name. Resolved via
   * lancamento → pagamento → contribuição lookup. Surfaces as the
   * primary row label ("Berço Montessoriano" instead of generic
   * "lançamento"). Falls back to the empty string when the
   * contribuição has been deleted between the pagamento and the
   * read — frontend defaults to a neutral "lançamento" affordance.
   */
  contribuicaoNome: z.string(),
  /**
   * aperture-k6fbz — the gift's image URL. Emoji glyph or hosted URL
   * per the existing contribuicao.imagemUrl shape. Null when the
   * gift was ad-hoc (no image) or the contribuição was deleted.
   */
  contribuicaoImagemUrl: z.string().nullable(),
  /**
   * aperture-qp4mq — per-item quantidade as encoded on the parent
   * intencao_items row this lançamento was spawned from (1:1 via
   * lancamento.idItemPagamento per Plan 0016 Phase 2 migration 023).
   * Multi-quantity purchases (operator buys 5 of a "fralda" slot
   * with quantidade=10 capacity) surface as 5 here, so the painel
   * extrato drawer can render "× 5" alongside the item name.
   * Defaults to 1 when the parent pagamento can't be resolved (deleted
   * between read + projection) — same defensive shape as
   * contribuicaoNome's empty-string fallback.
   */
  quantidade: z.number().int().positive(),
  amountCents: z.number().int().nonnegative(),
  /** Derived sub-state — drives the chip + sort affordance on the UI. */
  liberacao: ExtratoLiberacaoSchema,
  /** Parent pagamento criadoEm (ISO). The "contribution moment". */
  timestamp: z.string(),
  /**
   * aperture-75mw3 — predicted liberation date for aguardando rows.
   * ISO timestamp of when the parent pagamento's funds become available
   * to the recebedor (Stripe `charge.balance_transaction.available_on`).
   * `null` when liberacao !== 'aguardando_liberacao' OR when the
   * webhook hasn't populated availableOn yet (orphan window —
   * 1ewwh handles the retroactive sweep).
   *
   * Field is named for the FUTURE date semantics ("libera em DD/MM" —
   * the operator's UI label). Earlier shipped as `liberadoEm` which
   * was misnamed (past tense for a future value).
   */
  liberacaoPrevistaEm: z.string().nullable(),
});
export type ExtratoRowDTO = z.infer<typeof ExtratoRowDTOSchema>;

const ExtratoStatusFilterSchema = z.enum([
  "aguardando_liberacao",
  "disponivel",
  "solicitado",
  "transferido",
]);

const ExtratoListInputSchema = z.object({
  idCampanha: z.string().uuid(),
  statusFilters: z.array(ExtratoStatusFilterSchema).default([]),
  cursor: z.string().nullable(),
  limit: z.number().int().min(1).max(100).default(20),
});

const ExtratoListOutputSchema = z.object({
  rows: z.array(ExtratoRowDTOSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

const TransferenciaSolicitarInputSchema = z.object({
  idCampanha: z.string().uuid(),
});

const TransferenciaSolicitarOutputSchema = z.object({
  idRepasse: z.string(),
  amountCents: z.number().int().nonnegative(),
  solicitadoEm: z.string(),
  numLancamentos: z.number().int().nonnegative(),
});

// ────────────────────────────────────────────────────────────────────
//  recebedor.listMovimentacoes — OUT-movement projection (aperture-2u5vw)
//
//  The resgatado-detail modal previously showed "0 movimentações"
//  because nothing projected the account-transfer (repasse) side of the
//  ledger. This query groups the TRANSFERIDO recebedor lançamentos by
//  idRepasse — one movimentação per admin transfer (transfer date +
//  summed amount + ticket count). Only an out-type exists today
//  (transferencia_conta); there is no resgate-loja concept.
// ────────────────────────────────────────────────────────────────────

const MovimentacaoDTOSchema = z.object({
  idRepasse: z.string(),
  data: z.string(), // ISO transferidoEm (the transfer date)
  valorCents: z.number().int().nonnegative(),
  quantidade: z.number().int().positive(),
  tipo: z.literal("transferencia_conta"), // only out-type today; no resgate-loja concept exists
});

const ListMovimentacoesOutputSchema = z.object({
  movimentacoes: z.array(MovimentacaoDTOSchema),
});

// ────────────────────────────────────────────────────────────────────
//  Auth helpers — same shape as contribuicao-router
// ────────────────────────────────────────────────────────────────────

class SessaoAusenteError extends Error {
  public readonly name = "SessaoAusenteError";
}

function readSessionCookie(headers: Headers, name: string): string | null {
  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const target = `${name}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(target)) {
      return decodeURIComponent(cookie.slice(target.length));
    }
  }
  return null;
}

/**
 * Resolve the caller's session and verify they administer `idCampanha`.
 * Throws UNAUTHORIZED on:
 *   - missing/invalid session
 *   - usuario row missing
 *   - the user is NOT in campanha.idsAdministradores
 *   - the campanha doesn't exist (don't leak existence — same code as
 *     forbidden)
 *
 * Returns the resolved campanha when authorized.
 */
async function resolveAdminOfCampanha(
  ctx: TrpcContext,
  idCampanha: string,
): Promise<{ idConta: IdConta; campanha: Campanha }> {
  const { deps, headers } = ctx;
  const token = readSessionCookie(headers, deps.sessionCookieName);
  if (!token) throw new SessaoAusenteError("Sessao ausente");

  let sessao;
  try {
    sessao = await deps.authService.validarSessao(token);
  } catch {
    throw new SessaoAusenteError("Sessao invalida");
  }
  if (!sessao) throw new SessaoAusenteError("Sessao expirada");

  const usuario = await deps.usuarioRepository.findUsuarioById(sessao.idUsuario);
  if (!usuario) throw new SessaoAusenteError("Usuario nao encontrado");

  const campanha = await deps.campanhaRepository.findById(idCampanha as IdCampanha);
  if (!campanha) {
    // Don't leak existence — same posture as wrong-tenant.
    throw new SessaoAusenteError("Campanha nao encontrada ou nao autorizada");
  }
  if (!campanha.idsAdministradores.includes(usuario.idConta)) {
    throw new SessaoAusenteError("Campanha nao encontrada ou nao autorizada");
  }
  return { idConta: usuario.idConta, campanha };
}

function toTRPCError(err: unknown): TRPCError {
  if (err instanceof SessaoAusenteError) {
    return new TRPCError({ code: "UNAUTHORIZED", message: err.message, cause: err });
  }
  if (err instanceof FinanceiroRepasseJaPendenteError) {
    return new TRPCError({
      code: "CONFLICT",
      message: "repasse_ja_pendente",
      cause: err,
    });
  }
  if (err instanceof FinanceiroSaldoDisponivelInsuficienteError) {
    return new TRPCError({
      code: "UNPROCESSABLE_CONTENT",
      message: "saldo_disponivel_insuficiente",
      cause: err,
    });
  }
  if (err instanceof FinanceiroInputInvalidoError) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message, cause: err });
  }
  // aperture-mcvyw — a 'conta' (bank-account) recebedor cannot be paid via
  // the PIX repasse rail. Surface as a 422 so the painel can route the
  // operator to manual payout instead of a generic 500.
  if (err instanceof CheckoutRecebedorNaoPagavelViaPixError) {
    return new TRPCError({
      code: "UNPROCESSABLE_CONTENT",
      message: "recebedor_nao_pagavel_via_pix",
      cause: err,
    });
  }
  // aperture-0bynm — recebedor.criar mapping.
  if (err instanceof ArrecadacaoRecebedorJaExisteError) {
    return new TRPCError({
      code: "CONFLICT",
      message: "recebedor_ja_existe",
      cause: err,
    });
  }
  if (err instanceof ArrecadacaoNaoAutorizadoError) {
    return new TRPCError({ code: "UNAUTHORIZED", message: err.message, cause: err });
  }
  if (err instanceof ArrecadacaoCampanhaNaoEncontradaError) {
    // Don't leak existence — surface as UNAUTHORIZED, same posture as
    // resolveAdminOfCampanha.
    return new TRPCError({
      code: "UNAUTHORIZED",
      message: "campanha_nao_encontrada_ou_nao_autorizada",
      cause: err,
    });
  }
  if (err instanceof ArrecadacaoInputInvalidoError) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message, cause: err });
  }
  return err instanceof Error
    ? new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err.message, cause: err })
    : new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Unknown error" });
}

// ────────────────────────────────────────────────────────────────────
//  Shared composition helper
// ────────────────────────────────────────────────────────────────────

interface ExtratoLancamentoState {
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

/**
 * Walk every recebedor-tipo lançamento for the campanha and resolve
 * each one's parent pagamento + contribuição + derived liberação state.
 * N+1 across pagamentos + contribuições by design (see file header
 * note — v1 is bounded small; SQL aggregation is a follow-up).
 *
 * Excludes platform-revenue + passthrough-surcharge tipos (those don't
 * appear on the recebedor's extrato — only their own saldo).
 */
async function buildExtratoStates(
  ctx: TrpcContext,
  idCampanha: string,
  now: Date,
): Promise<ExtratoLancamentoState[]> {
  const lancamentos =
    await ctx.deps.livroFinanceiroRepository.findLancamentosByIdCampanha(
      idCampanha as IdCampanha,
    );
  const recebedorLancamentos = lancamentos.filter(
    (l) => l.tipo === "credito_saldo_recebedor",
  );

  const states: ExtratoLancamentoState[] = await Promise.all(
    recebedorLancamentos.map(async (lancamento) => {
      const pagamento = await ctx.deps.pagamentoRepository.findById(
        lancamento.idPagamento as never,
      );
      // aperture-sm7uc (#6 fix) — per-lançamento gift resolution.
      // Each LancamentoFinanceiro carries `idContribuicao` directly
      // (Plan 0016 Phase 2 / migration 023), so we resolve THIS row's
      // contribuição instead of collapsing the whole pagamento to the
      // first cart item — which was the regression that made every
      // ticket in a multi-item cart show the same name in the painel
      // extrato.
      //
      // When the contribuição has been deleted between pagamento and
      // read, contribuicao stays undefined and the projection falls
      // back to empty-string/null at the wire boundary. pagamento
      // presence isn't required for the name lookup, but we still
      // surface it via the parent state for timestamp + balance
      // metadata.
      let contribuicao: { nome: string; imagemUrl: string | null } | undefined;
      const fetched = await ctx.deps.contribuicaoRepository.findById(
        lancamento.idContribuicao as never,
      );
      if (fetched !== undefined && fetched !== null) {
        contribuicao = {
          nome: fetched.nome,
          imagemUrl: fetched.imagemUrl ?? null,
        };
      }
      return {
        lancamento,
        pagamento,
        contribuicao,
        liberacao: deriveLiberacao(lancamento, pagamento, now),
      };
    }),
  );
  return states;
}

function deriveLiberacao(
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

// ────────────────────────────────────────────────────────────────────
//  Cursor (page-token) shape — same family as admin.repasses.list:
//   `${pagamentoCriadoEm-ms}:${idLancamento}`
//  Stable DESC sort with id ASC tiebreaker. The list query filters
//  rows STRICTLY EARLIER than the cursor under that ordering.
// ────────────────────────────────────────────────────────────────────

function encodeRowCursor(state: ExtratoLancamentoState): string {
  const ts = state.pagamento?.criadoEm.getTime() ?? state.lancamento.criadoEm.getTime();
  return `${ts}:${state.lancamento.id}`;
}

function decodeCursorTuple(cursor: string): { ms: number; id: string } | null {
  const colonIdx = cursor.indexOf(":");
  if (colonIdx === -1) return null;
  const ms = Number(cursor.slice(0, colonIdx));
  if (Number.isNaN(ms)) return null;
  return { ms, id: cursor.slice(colonIdx + 1) };
}

// ────────────────────────────────────────────────────────────────────
//  Router
// ────────────────────────────────────────────────────────────────────

const extratoRouter = t.router({
  summary: t.procedure
    .input(z.object({ idCampanha: z.string().uuid() }))
    .output(ExtratoSummaryDTOSchema)
    .query(async ({ ctx, input }) => {
      try {
        await resolveAdminOfCampanha(ctx, input.idCampanha);

        const now = ctx.deps.clock();
        const states = await buildExtratoStates(ctx, input.idCampanha, now);

        const liveStates = states.filter((s) => s.liberacao !== "cancelado");

        let totalRecebidoCents = 0;
        let resgatadoCents = 0;
        let saldoDisponivelCents = 0;
        let aguardandoAprovacaoCents = 0;
        let aguardandoLiberacaoCents = 0;
        let proximaTransfMs: number | null = null;
        let dateRangeStartMs: number | null = null;
        let dateRangeEndMs: number | null = null;
        const distinctPagamentos = new Set<string>();
        // aperture-kvpvf — strip-counter accumulators.
        //   recadosPagamentoIds — distinct aprovado pagamentos with a
        //     non-null contribuinte.nome AND a non-empty trimmed
        //     mensagem. Same eligibility as B3's
        //     MuralRecadoProjection, just counted instead of projected.
        //   presentesItensCountedFor — pagamentos whose items we've
        //     already tallied (each pagamento appears once per
        //     lançamento in liveStates; we tally each one's items
        //     exactly once).
        //   totalPresentesItensCount — sum of `tipo='contribuicao'`
        //     items across all aprovado pagamentos. Surcharges
        //     skipped — they aren't gifts.
        const recadosPagamentoIds = new Set<string>();
        const presentesItensCountedFor = new Set<string>();
        let totalPresentesItensCount = 0;

        for (const state of liveStates) {
          const { lancamento, pagamento, liberacao } = state;
          totalRecebidoCents += lancamento.amountCents;
          distinctPagamentos.add(lancamento.idPagamento);

          // aperture-kvpvf — strip counters. We only want APROVADO
          // pagamentos (deriveLiberacao guarantees non-cancelado already,
          // but a parent pagamento can still be in pendente/rejeitado
          // when the lançamento hasn't materialised — defensive guard).
          if (pagamento && pagamento.status === "aprovado") {
            // Items count: tally once per pagamento, sum contribuicao-tipo items.
            if (!presentesItensCountedFor.has(pagamento.id)) {
              presentesItensCountedFor.add(pagamento.id);
              for (const item of pagamento.intencao.items) {
                if (item.tipo === "contribuicao") {
                  totalPresentesItensCount += 1;
                }
              }
            }
            // Recados count: same predicate as B3's
            // MuralRecadoProjection (findMensagensMuralByCampanha):
            // contribuinte non-null (carries nome by schema) AND
            // mensagem is a non-empty trimmed string.
            const contribuinte = pagamento.intencao.contribuinte;
            if (contribuinte !== null) {
              const mensagem = contribuinte.mensagem;
              if (
                typeof mensagem === "string" &&
                mensagem.trim().length > 0
              ) {
                recadosPagamentoIds.add(pagamento.id);
              }
            }
          }

          const tsMs =
            pagamento?.criadoEm.getTime() ?? lancamento.criadoEm.getTime();
          dateRangeStartMs =
            dateRangeStartMs === null ? tsMs : Math.min(dateRangeStartMs, tsMs);
          dateRangeEndMs =
            dateRangeEndMs === null ? tsMs : Math.max(dateRangeEndMs, tsMs);

          if (liberacao === "transferido") {
            resgatadoCents += lancamento.amountCents;
            continue;
          }
          // aperture-1ut92 — solicitado lançamentos sit in the
          // admin-pipeline bucket; they no longer count as actionable
          // saldo. saldoDisponivel only includes rows the recebedor
          // can still SOLICITAR on.
          if (liberacao === "solicitado") {
            aguardandoAprovacaoCents += lancamento.amountCents;
            continue;
          }
          if (liberacao === "disponivel") {
            saldoDisponivelCents += lancamento.amountCents;
            continue;
          }
          if (liberacao === "aguardando_liberacao") {
            aguardandoLiberacaoCents += lancamento.amountCents;
            const availableOn =
              pagamento?.intencao.balanceTransactionAvailableOn ?? null;
            if (availableOn !== null) {
              const ms = availableOn.getTime();
              proximaTransfMs = proximaTransfMs === null ? ms : Math.min(proximaTransfMs, ms);
            }
          }
        }

        return {
          totalRecebidoCents,
          resgatadoCents,
          saldoDisponivelCents,
          aguardandoAprovacaoCents,
          aguardandoLiberacaoCents,
          proximaTransfDate:
            proximaTransfMs === null ? null : new Date(proximaTransfMs).toISOString(),
          totalPresentes: distinctPagamentos.size,
          totalRecadosCount: recadosPagamentoIds.size,
          totalPresentesItensCount,
          dateRangeStart:
            dateRangeStartMs === null ? null : new Date(dateRangeStartMs).toISOString(),
          dateRangeEnd:
            dateRangeEndMs === null ? null : new Date(dateRangeEndMs).toISOString(),
        };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),

  list: t.procedure
    .input(ExtratoListInputSchema)
    .output(ExtratoListOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        await resolveAdminOfCampanha(ctx, input.idCampanha);

        const now = ctx.deps.clock();
        const allStates = await buildExtratoStates(ctx, input.idCampanha, now);

        // Filter: exclude cancelados from the extrato view (the recebedor
        // doesn't see refunded contributions on their extrato — they're
        // not part of their saldo trajectory). Status filters narrow
        // further when present.
        const filtered = allStates.filter((s) => {
          if (s.liberacao === "cancelado") return false;
          if (input.statusFilters.length === 0) return true;
          return (input.statusFilters as readonly ExtratoLiberacao[]).includes(
            s.liberacao,
          );
        });

        // Sort: pagamento.criadoEm DESC, id ASC.
        const sorted = filtered.slice().sort((a, b) => {
          const am = a.pagamento?.criadoEm.getTime() ?? a.lancamento.criadoEm.getTime();
          const bm = b.pagamento?.criadoEm.getTime() ?? b.lancamento.criadoEm.getTime();
          if (am !== bm) return bm - am;
          return a.lancamento.id.localeCompare(b.lancamento.id);
        });

        let startIdx = 0;
        if (input.cursor !== null) {
          const tuple = decodeCursorTuple(input.cursor);
          if (tuple !== null) {
            startIdx = sorted.findIndex((s) => {
              const sMs =
                s.pagamento?.criadoEm.getTime() ?? s.lancamento.criadoEm.getTime();
              if (sMs < tuple.ms) return true;
              if (sMs === tuple.ms && s.lancamento.id > tuple.id) return true;
              return false;
            });
            if (startIdx === -1) startIdx = sorted.length;
          }
        }

        const page = sorted.slice(startIdx, startIdx + input.limit);
        const hasMore = startIdx + input.limit < sorted.length;
        const nextCursor =
          hasMore && page.length > 0
            ? encodeRowCursor(page[page.length - 1] as ExtratoLancamentoState)
            : null;

        const rows: ExtratoRowDTO[] = page.map((s) => {
          // aperture-qp4mq — resolve THIS lançamento's parent
          // intencao_items row to read its per-item quantidade. The
          // FK lives at s.lancamento.idItemPagamento (Plan 0016 Phase
          // 2 — every lançamento carries the NOT-NULL item id), so the
          // lookup is unambiguous even in carts with two items pointing
          // at the same contribuição. Recebedor lançamentos are
          // pre-filtered to credito_saldo_recebedor (line 388) so the
          // matched item is always a contribuicao-tipo; the runtime
          // type guard keeps TS narrow + falls back to 1 if the parent
          // pagamento can't be resolved (deleted between read + projection).
          const items = s.pagamento?.intencao.items ?? [];
          const matchedItem = items.find(
            (i: (typeof items)[number]) =>
              i.id === s.lancamento.idItemPagamento,
          );
          const quantidade =
            matchedItem?.tipo === "contribuicao" ? matchedItem.quantidade : 1;
          return {
          idLancamento: s.lancamento.id,
          idPagamento: s.lancamento.idPagamento,
          contribuinteNome: s.pagamento?.intencao.contribuinte?.nome ?? null,
          // aperture-k6fbz: empty string + null fallback when the
          // contribuição is gone or unresolvable. UI handles either
          // with a neutral "lançamento" affordance.
          contribuicaoNome: s.contribuicao?.nome ?? "",
          contribuicaoImagemUrl: s.contribuicao?.imagemUrl ?? null,
          quantidade,
          amountCents: s.lancamento.amountCents as unknown as number,
          liberacao: s.liberacao,
          timestamp: (
            s.pagamento?.criadoEm ?? s.lancamento.criadoEm
          ).toISOString(),
          liberacaoPrevistaEm:
            s.liberacao === "aguardando_liberacao"
              ? (s.pagamento?.intencao.balanceTransactionAvailableOn?.toISOString() ??
                null)
              : null,
          };
        });

        return { rows, nextCursor, hasMore };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});

const transferenciaRouter = t.router({
  solicitar: t.procedure
    .input(TransferenciaSolicitarInputSchema)
    .output(TransferenciaSolicitarOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await resolveAdminOfCampanha(ctx, input.idCampanha);

        const idRepasse = randomUUID();
        const repasse = await solicitarRepasseRecebedor(
          {
            livroFinanceiroRepository: ctx.deps.livroFinanceiroRepository,
            clock: ctx.deps.clock,
            observability: ctx.deps.observability,
          },
          {
            idRepasse: idRepasse as never,
            idCampanha: input.idCampanha as never,
          },
        );

        // Count claimed lancamentos for the response — re-query.
        const linked =
          await ctx.deps.livroFinanceiroRepository.findLancamentosByIdRepasse(
            repasse.id,
          );

        return {
          idRepasse: repasse.id,
          amountCents: repasse.amountCents as unknown as number,
          solicitadoEm: repasse.solicitadoEm.toISOString(),
          numLancamentos: linked.length,
        };
      } catch (err) {
        throw toTRPCError(err);
      }
    }),
});

// ────────────────────────────────────────────────────────────────────
//  recebedor.criar — first-time onboarding (aperture-0bynm, kbmel)
// ────────────────────────────────────────────────────────────────────

const RecebedorCriarInputSchema = CriarRecebedorParaCampanhaInputSchema.pick({
  idCampanha: true,
  dadosRecebedor: true,
});

const RecebedorCriarOutputSchema = z.object({
  idRecebedor: z.string().uuid(),
});

const criarProcedure = t.procedure
  .input(RecebedorCriarInputSchema)
  .output(RecebedorCriarOutputSchema)
  .mutation(async ({ ctx, input }) => {
    try {
      // Admin guard + tenant resolution. resolveAdminOfCampanha throws
      // UNAUTHORIZED on missing session / non-admin caller / unknown
      // campanha (no existence leak). idConta is the caller's session-
      // derived identity that the use-case re-validates via its admin
      // guard (defense in depth).
      const { idConta } = await resolveAdminOfCampanha(ctx, input.idCampanha);

      const result = await criarRecebedorParaCampanha(
        {
          campanhaRepository: ctx.deps.campanhaRepository,
          recebedorRepository: ctx.deps.recebedorRepository,
          clock: ctx.deps.clock,
          observability: ctx.deps.observability,
        },
        {
          idCampanha: input.idCampanha,
          idContaCaller: idConta,
          dadosRecebedor: input.dadosRecebedor,
        },
      );
      return { idRecebedor: result.idRecebedor };
    } catch (err) {
      throw toTRPCError(err);
    }
  });

// ────────────────────────────────────────────────────────────────────
//  recebedor.listMovimentacoes (aperture-2u5vw)
// ────────────────────────────────────────────────────────────────────

const listMovimentacoesProcedure = t.procedure
  .input(z.object({ idCampanha: z.string().uuid() }))
  .output(ListMovimentacoesOutputSchema)
  .query(async ({ ctx, input }) => {
    try {
      await resolveAdminOfCampanha(ctx, input.idCampanha); // same auth as extrato.summary / extrato.list
      const now = ctx.deps.clock();
      const states = await buildExtratoStates(ctx, input.idCampanha, now);

      // Group the TRANSFERIDO recebedor lançamentos by idRepasse — one
      // movimentação per admin transfer (date + summed amount). The grain
      // here is credito_saldo_recebedor (buildExtratoStates already
      // filters to it), matching resgatadoCents in extrato.summary.
      const porRepasse = new Map<
        string,
        { data: Date; valorCents: number; quantidade: number }
      >();
      for (const s of states) {
        if (s.liberacao !== "transferido") continue;
        const idRepasse = s.lancamento.idRepasse;
        const transferidoEm = s.lancamento.transferidoEm;
        // Defensive — a transferido lançamento implies both are set.
        if (idRepasse === null || transferidoEm === null) continue;
        const key = idRepasse as unknown as string;
        const existing = porRepasse.get(key);
        if (existing) {
          existing.valorCents += s.lancamento.amountCents as unknown as number;
          existing.quantidade += 1;
          // keep the first transferidoEm — they should match within a repasse
        } else {
          porRepasse.set(key, {
            data: transferidoEm,
            valorCents: s.lancamento.amountCents as unknown as number,
            quantidade: 1,
          });
        }
      }

      const movimentacoes = [...porRepasse.entries()]
        .map(([idRepasse, g]) => ({
          idRepasse,
          data: g.data.toISOString(),
          valorCents: g.valorCents,
          quantidade: g.quantidade,
          tipo: "transferencia_conta" as const,
        }))
        .sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0)); // data desc

      return { movimentacoes };
    } catch (err) {
      throw toTRPCError(err);
    }
  });

export const recebedorRouter = t.router({
  criar: criarProcedure,
  extrato: extratoRouter,
  transferencia: transferenciaRouter,
  listMovimentacoes: listMovimentacoesProcedure,
});
