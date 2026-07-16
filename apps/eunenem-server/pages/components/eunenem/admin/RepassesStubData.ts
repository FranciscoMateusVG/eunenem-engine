import { TRPCClientError } from "@trpc/client";
import { useState } from "react";
import { trpc } from "@/lib/trpc.js";

/**
 * Repasses data layer — plan q2d4b Track 3 (post-swap).
 *
 * Rex's Track 3 backend (aperture-riywh, PR #142) has been LIVE on
 * staging since the vi0hy reconciliation. This module previously
 * shipped djb2-seeded stubs against the locked contract; now the hook
 * bodies call real trpc procs and the fixtures are gone (aperture-mqrzt
 * follow-up to aperture-28mja).
 *
 * Procs in play (all under `trpc.admin.repasses.*`):
 *   - list({ statusFilter, cursor, limit })  → query
 *   - show({ idRepasse })                    → query
 *   - aprovar({ idRepasse, bankTransferRef }) → mutation
 *
 * Auth: admin-scope (no recebedor session check — operators see ALL
 * repasses across campanhas). v1 has no admin auth gate per dispatch.
 *
 * Drift catches reconciled in this swap:
 *   - `recebedorNome: string` → `string | null`. Rex's wire allows null
 *     for deactivated-recebedor cases. Consumer renders a
 *     "(sem recebedor)" affordance for null.
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
  // ── Inter transfer fields (spec §4.2, frozen). Rex's admin-router DTO is
  //    NOT yet widened to send these — the list hook defaults them until his
  //    aperture-vvh2j tRPC surface lands (see the swap note on the hook). ──
  /** Stable idempotency anchor, generated once at approval. Null pre-approval. */
  transferReferencia: string | null;
  /** Inter's payment id (codigoSolicitacao), set as soon as known. */
  interCodigoSolicitacao: string | null;
  /** Monotonic attempt counter; 0 before the first transfer fires. */
  transferAttempts: number;
  /** Operator-facing Inter error code (never PII). Null unless a failure occurred. */
  lastTransferError: string | null;
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

export type RepasseDetail = RepasseListRow & {
  lancamentos: readonly RepasseDetailLancamento[];
  /**
   * Transfer attempt history (newest work last). Empty until the first
   * transfer fires. Pending Rex's `repasses.show` DTO widening — the detail
   * hook defaults this to `[]` until then.
   */
  attempts: readonly RepasseTransferAttempt[];
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
 * Wire → UI row adapter. Rex's `RepasseAdminDTO` is still the 2-state shape and
 * does NOT yet carry the transfer fields (aperture-vvh2j widens it). Reading
 * the new fields DEFENSIVELY (typeof-guarded off the raw row) makes this
 * forward-compatible: it defaults today and flows real values the moment his
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
    transferReferencia: optStr(row, "transferReferencia"),
    interCodigoSolicitacao: optStr(row, "interCodigoSolicitacao"),
    transferAttempts: optNum(row, "transferAttempts"),
    lastTransferError: optStr(row, "lastTransferError"),
  };
}

function optStr(row: object, key: string): string | null {
  const v = (row as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function optNum(row: object, key: string): number {
  const v = (row as Record<string, unknown>)[key];
  return typeof v === "number" ? v : 0;
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
 * Wire → UI detail adapter. Same forward-compatible defaulting as `toListRow`,
 * plus the attempt history: Rex's `repasses.show` DTO does not yet embed
 * `attempts` (reads `repasse_transfer_attempts`), so it defaults to `[]` until
 * his DTO widening lands.
 */
function toDetail(
  repasse: Parameters<typeof toListRow>[0] & {
    lancamentos: readonly RepasseDetailLancamento[];
  },
): RepasseDetail {
  return {
    ...toListRow(repasse),
    lancamentos: repasse.lancamentos,
    attempts: readAttempts(repasse),
  };
}

function readAttempts(repasse: object): readonly RepasseTransferAttempt[] {
  const v = (repasse as Record<string, unknown>).attempts;
  return Array.isArray(v) ? (v as RepasseTransferAttempt[]) : [];
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
  const error: { code: string; message: string } | null =
    mutation.error && mutation.error instanceof TRPCClientError
      ? { code: extractCode(mutation.error), message: mutation.error.message }
      : mutation.error
        ? { code: "INTERNAL_SERVER_ERROR", message: mutation.error.message }
        : null;
  return {
    mutate: (input) => mutation.mutate(input),
    isPending: mutation.isPending,
    error,
    data: mutation.data ?? null,
  };
}

// ── Retry / Cancelar (falhou-only actions) ─────────────────────────────────
//
// PLACEHOLDER MUTATIONS. `trpc.admin.repasses.retry` and `.cancelar` do NOT
// exist yet — Rex owes them on aperture-vvh2j (see the contract request in the
// aperture-voao0 bead). These local simulations keep the scaffold interactive
// for design review; at ship time each becomes a real
// `trpc.admin.repasses.<retry|cancelar>.useMutation({ onSuccess })` with the
// same list+detail invalidation the aprovar hook does — no consumer change.

export type RetryMutationState = {
  mutate: (input: { idRepasse: string }) => void;
  isPending: boolean;
  error: { code: string; message: string } | null;
  data: RetryMutationResult | null;
};

export function useStubRepasseRetry(
  onSuccess: (result: RetryMutationResult) => void,
): RetryMutationState {
  const [data, setData] = useState<RetryMutationResult | null>(null);
  return {
    mutate: (input) => {
      const result: RetryMutationResult = {
        idRepasse: input.idRepasse,
        status: "transferindo",
        transferAttempts: 0,
      };
      setData(result);
      onSuccess(result);
    },
    isPending: false,
    error: null,
    data,
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
  const [data, setData] = useState<CancelarMutationResult | null>(null);
  return {
    mutate: (input) => {
      const result: CancelarMutationResult = {
        idRepasse: input.idRepasse,
        status: "cancelado",
        // Real backend returns the count of released lançamentos; the
        // placeholder omits it (0 → the success UI hides the count line).
        numLancamentosLiberados: 0,
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
