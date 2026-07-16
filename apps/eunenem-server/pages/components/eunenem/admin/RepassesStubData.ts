import { TRPCClientError } from "@trpc/client";
import { trpc } from "@/lib/trpc.js";

/**
 * Repasses data layer — plan q2d4b Track 3 (post-swap), widened for the
 * Inter PIX transfer FSM (aperture-vvh2j merged to staging, 1cd53c3).
 *
 * Procs in play (all under `trpc.admin.repasses.*`):
 *   - list({ statusFilter, cursor, limit })   → query (7-state DTO + transfer fields)
 *   - show({ idRepasse })                     → query (detail + attempts[] + candidatos)
 *   - aprovar({ idRepasse, bankTransferRef }) → mutation
 *   - retry({ idRepasse })                    → mutation (falhou → transferindo)
 *   - cancelar({ idRepasse })                 → mutation (falhou → cancelado)
 *   - resolverManualPago({ idRepasse, codigoSolicitacao }) → mutation (§5.4)
 *   - resolverManualFalhou({ idRepasse })     → mutation (§5.4)
 *
 * Auth: admin-scope (no recebedor session check — operators see ALL
 * repasses across campanhas). v1 has no admin auth gate per dispatch.
 *
 * Drift catches reconciled in this swap:
 *   - `recebedorNome: string` → `string | null`. Rex's wire allows null
 *     for deactivated-recebedor cases. Consumer renders a
 *     "(sem recebedor)" affordance for null.
 *   - Mutation outputs type `status` as plain `string` on the wire (not the
 *     enum); the hooks narrow it — the FSM guarantees the value.
 *   - §5.4 candidates ride the show DTO as `candidatos`
 *     (RepasseReconciliacaoCandidatoDTO[]) with `dataMovimento: string|null`
 *     — NOT the `searchCandidates`/`data` shape this module scaffolded.
 *     Wire name mapped here; UI keeps `searchCandidates`.
 *   - resolverManual* are IDEMPOTENT NO-OPS from any non-legal state (the
 *     repository concurrency guard): they return the CURRENT status instead
 *     of erroring. Consumers must render off the returned status, not the
 *     asserted one (concurrent-resolution race, aperture-477nz).
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
   * Live on both list + show DTOs since aperture-477nz.
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
 * Mirrors Rex's `RepasseReconciliacaoCandidatoDTO` (aperture-477nz)
 * verbatim; rides the show DTO under the wire name `candidatos`.
 */
export type RepasseSearchCandidate = {
  /** Inter's payment id — what "Marcar como pago" records as the match. */
  codigoSolicitacao: string;
  valorCents: number;
  /** ISO date of the payment movement on Inter's side; null when unknown. */
  dataMovimento: string | null;
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
   * (spec §5.4). Wire field `candidatos` (aperture-477nz), mapped here.
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
 * Wire → UI row adapter. Rex's `RepasseAdminDTO` carries the 7-state status,
 * the four transfer fields (vvh2j) and the §5.4 manual-resolution flag
 * (477nz) — everything maps directly; the single swap point stays this file.
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
  needsManualResolution: boolean;
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
    needsManualResolution: row.needsManualResolution,
  };
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
 * Wire → UI detail adapter. `attempts` (vvh2j, attemptNo ascending) and
 * `candidatos` (477nz, §5.4 masked reconciliation candidates) are embedded
 * on the show DTO — `candidatos` is renamed to the UI-side
 * `searchCandidates` here, the module's single wire↔UI seam.
 */
function toDetail(
  repasse: Parameters<typeof toListRow>[0] & {
    lancamentos: readonly RepasseDetailLancamento[];
    attempts: readonly RepasseTransferAttempt[];
    candidatos: readonly RepasseSearchCandidate[];
  },
): RepasseDetail {
  return {
    ...toListRow(repasse),
    lancamentos: repasse.lancamentos,
    attempts: repasse.attempts,
    searchCandidates: repasse.candidatos,
  };
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
// REAL since aperture-477nz (7a43952). Both mirror retry/cancelar:
// list+show invalidation, typed-code errors (NOT_FOUND / CONFLICT /
// BAD_REQUEST). IDEMPOTENCY CONTRACT: from any state other than a flagged
// `verificando`, the backend no-ops and returns the CURRENT status — no
// error. Consumers key their success UI off `result.status`, never off the
// assertion they made (two admins can race on the same parked repasse).

export type ResolverManualPagoResult = {
  idRepasse: string;
  /**
   * `pago` when this call resolved the repasse; any other value means a
   * concurrent resolution won and this is the actual current state.
   */
  status: RepasseStatus;
  /**
   * The codigoSolicitacao the operator submitted (echoed client-side —
   * the wire output doesn't carry it).
   */
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
  const utils = trpc.useUtils();
  const mutation = trpc.admin.repasses.resolverManualPago.useMutation({
    onSuccess: async (result, input) => {
      await Promise.all([
        utils.admin.repasses.list.invalidate(),
        utils.admin.repasses.show.invalidate(),
      ]);
      onSuccess({
        idRepasse: result.idRepasse,
        status: result.status as RepasseStatus,
        codigoSolicitacao: input.codigoSolicitacao,
      });
    },
  });
  return {
    mutate: (input) => mutation.mutate(input),
    isPending: mutation.isPending,
    error: toMutationError(mutation.error),
    data:
      mutation.data && mutation.variables
        ? {
            idRepasse: mutation.data.idRepasse,
            status: mutation.data.status as RepasseStatus,
            codigoSolicitacao: mutation.variables.codigoSolicitacao,
          }
        : null,
  };
}

export type ResolverManualFalhouResult = {
  idRepasse: string;
  /**
   * `falhou` when this call resolved the repasse (retry/cancelar take over);
   * any other value means a concurrent resolution won.
   */
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
  const utils = trpc.useUtils();
  const mutation = trpc.admin.repasses.resolverManualFalhou.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        utils.admin.repasses.list.invalidate(),
        utils.admin.repasses.show.invalidate(),
      ]);
      onSuccess({
        idRepasse: result.idRepasse,
        status: result.status as RepasseStatus,
      });
    },
  });
  return {
    mutate: (input) => mutation.mutate(input),
    isPending: mutation.isPending,
    error: toMutationError(mutation.error),
    data: mutation.data
      ? {
          idRepasse: mutation.data.idRepasse,
          status: mutation.data.status as RepasseStatus,
        }
      : null,
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
