import { TRPCClientError } from "@trpc/client";
import { useState } from "react";
import { trpc } from "@/lib/trpc.js";

/**
 * Repasses data layer — plan q2d4b Track 3 (post-swap), widened for the
 * Inter PIX transfer FSM (aperture-vvh2j merged to staging, 1cd53c3).
 *
 * Procs in play (all under `trpc.admin.repasses.*`):
 *   - list({ statusFilter, cursor, limit })   → query (7-state DTO + transfer fields)
 *   - show({ idRepasse })                     → query (detail + attempts[] history)
 *   - aprovar({ idRepasse, bankTransferRef }) → mutation
 *   - retry({ idRepasse })                    → mutation (falhou → transferindo)
 *   - cancelar({ idRepasse })                 → mutation (falhou → cancelado)
 *
 * Auth: admin-scope (no recebedor session check — operators see ALL
 * repasses across campanhas). v1 has no admin auth gate per dispatch.
 *
 * Drift catches reconciled in this swap:
 *   - `recebedorNome: string` → `string | null`. Rex's wire allows null
 *     for deactivated-recebedor cases. Consumer renders a
 *     "(sem recebedor)" affordance for null.
 *   - retry/cancelar output `status` as plain `string` on the wire (not the
 *     enum); the hooks narrow it — the FSM guarantees the value.
 *
 * STILL PLACEHOLDER (spec §5.4 amendment, Rex's aperture-ju5w2 pending):
 * manual resolution of search-fallback `verificando` repasses — the
 * needs-manual-resolution flag, the search-candidate list, and the
 * resolverManualPago/resolverManualFalhou mutations. Flag + candidates are
 * defensive-read off the wire (default off/empty) so the UI activates the
 * moment his DTO widening lands; the two mutations are local simulations
 * to swap exactly like retry/cancelar were.
 */

// ── Locked contract types (mirror Rex's exports verbatim) ──────────────────
//
// Kept LOCAL to this module per the same discipline used for ExtratoStubData:
// avoids pulling server-only deps via the router file path into the frontend
// bundle. Shapes match `admin-router.ts` lines 1179-1206 verbatim.

/**
 * aperture-voao0 — the FSM widened from the 2-state manual flow to the full
 * 7-state Inter PIX transfer lifecycle (spec §4.1, frozen; mirrors Rex's
 * `StatusRepasseSchema` on aperture-vvh2j verbatim).
 *
 *   solicitado → aprovado → transferindo → pago
 *                                ├→ verificando → pago | falhou
 *                                └→ falhou ─(retry)→ transferindo
 *                                       └─(cancel)→ cancelado
 *
 * The `conta` (manual bankTransferRef) path stays `solicitado → aprovado` and
 * never enters the transfer states — those are `pix`-metodo only.
 */
export type RepasseStatus =
  | "solicitado"
  | "aprovado"
  | "transferindo"
  | "verificando"
  | "pago"
  | "falhou"
  | "cancelado";

export type RepasseListRow = {
  idRepasse: string;
  idCampanha: string;
  campanhaTitulo: string;
  /** Null when the recebedor was deactivated post-solicitação. */
  recebedorNome: string | null;
  amountCents: number;
  numLancamentos: number;
  status: RepasseStatus;
  solicitadoEm: string;
  aprovadoEm: string | null;
  bankTransferRef: string | null;
  // ── Inter transfer fields (spec §4.2) — live on the wire since vvh2j. ──
  /** Stable idempotency anchor, generated once at approval. Null pre-approval. */
  transferReferencia: string | null;
  /** Inter's payment id (codigoSolicitacao), set as soon as known. */
  interCodigoSolicitacao: string | null;
  /** Monotonic attempt counter; 0 before the first transfer fires. */
  transferAttempts: number;
  /** Operator-facing Inter error code (never PII). Null unless a failure occurred. */
  lastTransferError: string | null;
  /**
   * Spec §5.4 (amended): Inter cannot echo our referencia, so search-fallback
   * reconciliation is human-resolved. True on a `verificando` repasse whose
   * reconciliation found search candidates and parked awaiting an operator.
   * DEFENSIVE-READ (defaults false) until Rex's aperture-ju5w2 DTO lands.
   */
  needsManualResolution: boolean;
};

export type RepasseDetailLancamento = {
  idLancamento: string;
  idPagamento: string;
  idContribuicao: string;
  amountCents: number;
  /** Null on anonymous-checkout rows OR pre-Phase-3 historical rows. */
  contribuinteNome: string | null;
  /** ISO. */
  pagamentoCriadoEm: string;
};

/**
 * One row of the append-only `repasse_transfer_attempts` audit table (spec
 * §4.2). The intent row is committed BEFORE the Inter HTTP call, so an
 * attempt with `finishedAt === null` is an in-flight (or crashed-mid-call)
 * attempt — the reconciliation signal. Ordered by `attemptNo` ascending.
 */
export type RepasseTransferAttempt = {
  /** Audit-row id — the stable React key for timeline rows. */
  id: string;
  attemptNo: number;
  referencia: string;
  startedAt: string;
  finishedAt: string | null;
  /** Non-PII summary (valor + masked chave type). */
  requestSummary: string | null;
  /** pago | agendado_aprovacao | rejeitado | ambiguo | transitorio | null (in-flight). */
  outcome: string | null;
  codigoSolicitacao: string | null;
  /** Inter error code only, never PII. */
  error: string | null;
};

/**
 * One persisted search-fallback candidate (spec §5.4 amended): an Inter
 * payment surfaced by `buscarPagamentos` that MIGHT be our transfer. The
 * operator resolves the ambiguity by matching (or asserting no match).
 * Shape is Vance's contract request to Rex (aperture-ju5w2) — mirror his
 * export verbatim when it lands.
 */
export type RepasseSearchCandidate = {
  /** Inter's payment id — what "Marcar como pago" records as the match. */
  codigoSolicitacao: string;
  valorCents: number;
  /** ISO date of the payment on Inter's side. */
  data: string;
  /** Masked destination chave (never the full key — PII discipline). */
  chaveMascarada: string | null;
  /** Free-text PIX description when Inter returns one. */
  descricaoPix: string | null;
};

export type RepasseDetail = RepasseListRow & {
  lancamentos: readonly RepasseDetailLancamento[];
  /**
   * Transfer attempt history (attemptNo ascending on the wire). Empty until
   * the first transfer fires.
   */
  attempts: readonly RepasseTransferAttempt[];
  /**
   * Persisted search candidates for a needs-manual-resolution repasse
   * (spec §5.4). DEFENSIVE-READ (defaults `[]`) until aperture-ju5w2 lands.
   */
  searchCandidates: readonly RepasseSearchCandidate[];
};

export type AprovarMutationResult = {
  idRepasse: string;
  aprovadoEm: string;
  numLancamentosTransferidos: number;
  totalCents: number;
};

export type RetryMutationResult = {
  idRepasse: string;
  /** State after re-firing — `transferindo`. */
  status: RepasseStatus;
  transferAttempts: number;
};

export type CancelarMutationResult = {
  idRepasse: string;
  /** Terminal `cancelado`. */
  status: RepasseStatus;
  /** Lançamentos released back to the recebedor's saldo. */
  numLancamentosLiberados: number;
};

// ── Hook-shaped surface (real trpc) ────────────────────────────────────────

export type RepassesListResult = {
  rows: readonly RepasseListRow[];
  isLoading: boolean;
  error: { message: string } | null;
};

export type RepasseDetailResult = {
  data: RepasseDetail | null;
  isLoading: boolean;
  error: { message: string } | null;
};

export type AprovarMutationState = {
  mutate: (input: {
    idRepasse: string;
    bankTransferRef: string | null;
  }) => void;
  isPending: boolean;
  error: { code: string; message: string } | null;
  data: AprovarMutationResult | null;
};

/**
 * List view. Rex's contract supports a server-side statusFilter, but the UI
 * here renders filter chips with per-status counts that need the FULL list to
 * compute. We pass `statusFilter: "all"` and filter client-side; the chip
 * counts come from `rows.filter(s).length`. For prod-scale this would flip to
 * server-side filter + separate count queries.
 */
export function useStubRepassesList(): RepassesListResult {
  const query = trpc.admin.repasses.list.useQuery({
    statusFilter: "all",
    cursor: null,
    limit: 100,
  });
  return {
    rows: (query.data?.rows ?? []).map(toListRow),
    isLoading: query.isLoading,
    error: query.error ? { message: query.error.message } : null,
  };
}

/**
 * Wire → UI row adapter. Rex's `RepasseAdminDTO` carries the 7-state status
 * and the four transfer fields since vvh2j — those map directly. Only the
 * §5.4 manual-resolution flag is still read DEFENSIVELY (typeof-guarded off
 * the raw row): it defaults today and flows the moment his aperture-ju5w2
 * DTO widening lands — no consumer change, single swap point stays this file.
 */
function toListRow(row: {
  idRepasse: string;
  idCampanha: string;
  campanhaTitulo: string;
  recebedorNome: string | null;
  amountCents: number;
  numLancamentos: number;
  status: RepasseStatus;
  solicitadoEm: string;
  aprovadoEm: string | null;
  bankTransferRef: string | null;
  transferReferencia: string | null;
  interCodigoSolicitacao: string | null;
  transferAttempts: number;
  lastTransferError: string | null;
}): RepasseListRow {
  return {
    idRepasse: row.idRepasse,
    idCampanha: row.idCampanha,
    campanhaTitulo: row.campanhaTitulo,
    recebedorNome: row.recebedorNome,
    amountCents: row.amountCents,
    numLancamentos: row.numLancamentos,
    status: row.status,
    solicitadoEm: row.solicitadoEm,
    aprovadoEm: row.aprovadoEm,
    bankTransferRef: row.bankTransferRef,
    transferReferencia: row.transferReferencia,
    interCodigoSolicitacao: row.interCodigoSolicitacao,
    transferAttempts: row.transferAttempts,
    lastTransferError: row.lastTransferError,
    needsManualResolution: optBool(row, "needsManualResolution"),
  };
}

function optBool(row: object, key: string): boolean {
  const v = (row as Record<string, unknown>)[key];
  return typeof v === "boolean" ? v : false;
}

/**
 * Detail view. Rex's contract returns `null` for unknown or cross-tenant ids
 * (no existence leak); the consumer renders a not-found affordance.
 */
export function useStubRepasseDetail(idRepasse: string): RepasseDetailResult {
  const query = trpc.admin.repasses.show.useQuery(
    { idRepasse },
    { enabled: isUuid(idRepasse) },
  );
  return {
    data: query.data?.repasse ? toDetail(query.data.repasse) : null,
    isLoading: query.isLoading,
    error: query.error ? { message: query.error.message } : null,
  };
}

/**
 * Wire → UI detail adapter. `attempts` is embedded on the show DTO since
 * vvh2j (attemptNo ascending, from `repasse_transfer_attempts`). The §5.4
 * `searchCandidates` list stays defensive-read (defaults `[]`) until
 * aperture-ju5w2 lands.
 */
function toDetail(
  repasse: Parameters<typeof toListRow>[0] & {
    lancamentos: readonly RepasseDetailLancamento[];
    attempts: readonly RepasseTransferAttempt[];
  },
): RepasseDetail {
  return {
    ...toListRow(repasse),
    lancamentos: repasse.lancamentos,
    attempts: repasse.attempts,
    searchCandidates: readSearchCandidates(repasse),
  };
}

function readSearchCandidates(
  repasse: object,
): readonly RepasseSearchCandidate[] {
  const v = (repasse as Record<string, unknown>).searchCandidates;
  return Array.isArray(v) ? (v as RepasseSearchCandidate[]) : [];
}

/**
 * Aprovar mutation. Surfaces 404 NOT_FOUND + 409 CONFLICT per Rex's contract.
 * The success handler invalidates list + detail queries so the page reflects
 * the new state without a manual refresh.
 */
export function useStubRepasseAprovar(
  onSuccess: (result: AprovarMutationResult) => void,
): AprovarMutationState {
  const utils = trpc.useUtils();
  const mutation = trpc.admin.repasses.aprovar.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.admin.repasses.list.invalidate(),
        utils.admin.repasses.show.invalidate(),
      ]);
      onSuccess(result);
    },
  });
  return {
    mutate: (input) => mutation.mutate(input),
    isPending: mutation.isPending,
    error: toMutationError(mutation.error),
    data: mutation.data ?? null,
  };
}

// ── Retry / Cancelar (falhou-only actions) ─────────────────────────────────
//
// REAL since vvh2j (1cd53c3). Both mirror the aprovar hook: list+show
// invalidation on success, typed-code error extraction (NOT_FOUND for an
// unknown id, CONFLICT for a non-`falhou` repasse). The wire types `status`
// as plain `string`; the FSM guarantees the value, so the hooks narrow it.

export type RetryMutationState = {
  mutate: (input: { idRepasse: string }) => void;
  isPending: boolean;
  error: { code: string; message: string } | null;
  data: RetryMutationResult | null;
};

export function useStubRepasseRetry(
  onSuccess: (result: RetryMutationResult) => void,
): RetryMutationState {
  const utils = trpc.useUtils();
  const mutation = trpc.admin.repasses.retry.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.admin.repasses.list.invalidate(),
        utils.admin.repasses.show.invalidate(),
      ]);
      onSuccess({ ...result, status: result.status as RepasseStatus });
    },
  });
  return {
    mutate: (input) => mutation.mutate(input),
    isPending: mutation.isPending,
    error: toMutationError(mutation.error),
    data: mutation.data
      ? { ...mutation.data, status: mutation.data.status as RepasseStatus }
      : null,
  };
}

export type CancelarMutationState = {
  mutate: (input: { idRepasse: string }) => void;
  isPending: boolean;
  error: { code: string; message: string } | null;
  data: CancelarMutationResult | null;
};

export function useStubRepasseCancelar(
  onSuccess: (result: CancelarMutationResult) => void,
): CancelarMutationState {
  const utils = trpc.useUtils();
  const mutation = trpc.admin.repasses.cancelar.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.admin.repasses.list.invalidate(),
        utils.admin.repasses.show.invalidate(),
      ]);
      onSuccess({ ...result, status: result.status as RepasseStatus });
    },
  });
  return {
    mutate: (input) => mutation.mutate(input),
    isPending: mutation.isPending,
    error: toMutationError(mutation.error),
    data: mutation.data
      ? { ...mutation.data, status: mutation.data.status as RepasseStatus }
      : null,
  };
}

// ── Manual resolution (spec §5.4 amended — search-fallback verificando) ────
//
// PLACEHOLDER MUTATIONS. `trpc.admin.repasses.resolverManualPago` and
// `.resolverManualFalhou` do NOT exist yet — Rex is building them on
// aperture-ju5w2 (Inter can't echo our referencia, so an operator resolves
// parked `verificando` repasses by matching a search candidate or asserting
// no payment exists). These local simulations keep the scaffold interactive;
// at ship time each becomes a real
// `trpc.admin.repasses.resolverManual<Pago|Falhou>.useMutation({ onSuccess })`
// with the same list+show invalidation the hooks above do — no consumer
// change. Exactly the pattern retry/cancelar followed before vvh2j landed.

export type ResolverManualPagoResult = {
  idRepasse: string;
  /** Terminal `pago` — the matched payment is recorded as ours. */
  status: RepasseStatus;
  /** The codigoSolicitacao the operator matched. */
  codigoSolicitacao: string;
};

export type ResolverManualPagoState = {
  mutate: (input: { idRepasse: string; codigoSolicitacao: string }) => void;
  isPending: boolean;
  error: { code: string; message: string } | null;
  data: ResolverManualPagoResult | null;
};

export function useStubRepasseResolverManualPago(
  onSuccess: (result: ResolverManualPagoResult) => void,
): ResolverManualPagoState {
  const [data, setData] = useState<ResolverManualPagoResult | null>(null);
  return {
    mutate: (input) => {
      const result: ResolverManualPagoResult = {
        idRepasse: input.idRepasse,
        status: "pago",
        codigoSolicitacao: input.codigoSolicitacao,
      };
      setData(result);
      onSuccess(result);
    },
    isPending: false,
    error: null,
    data,
  };
}

export type ResolverManualFalhouResult = {
  idRepasse: string;
  /** `falhou` — retry/cancelar affordances take over from here. */
  status: RepasseStatus;
};

export type ResolverManualFalhouState = {
  mutate: (input: { idRepasse: string }) => void;
  isPending: boolean;
  error: { code: string; message: string } | null;
  data: ResolverManualFalhouResult | null;
};

export function useStubRepasseResolverManualFalhou(
  onSuccess: (result: ResolverManualFalhouResult) => void,
): ResolverManualFalhouState {
  const [data, setData] = useState<ResolverManualFalhouResult | null>(null);
  return {
    mutate: (input) => {
      const result: ResolverManualFalhouResult = {
        idRepasse: input.idRepasse,
        status: "falhou",
      };
      setData(result);
      onSuccess(result);
    },
    isPending: false,
    error: null,
    data,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isUuid(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    s,
  );
}

/** Uniform mutation-error shape across aprovar/retry/cancelar hooks. */
function toMutationError(
  err: unknown,
): { code: string; message: string } | null {
  if (!err) return null;
  if (err instanceof TRPCClientError) {
    return { code: extractCode(err), message: err.message };
  }
  return {
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Best-effort TRPCError code extraction. Same shape as the ExtratoStubData
 * swap — read from .data.code or .shape.data.code (defensive across
 * transformer-config variants).
 */
function extractCode(err: TRPCClientError<never>): string {
  const dataCode = (err.data as { code?: unknown } | null | undefined)?.code;
  if (typeof dataCode === "string") return dataCode;
  const shapeCode = (
    err.shape as { data?: { code?: unknown } } | null | undefined
  )?.data?.code;
  if (typeof shapeCode === "string") return shapeCode;
  return "INTERNAL_SERVER_ERROR";
}
