import { TRPCClientError } from "@trpc/client";
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

// aperture-vvh2j (Rex) — widened to the full 7-state transfer FSM so the
// list/show procs' real DTOs assign cleanly. Vance owns the UI-side type
// enrichment (the 4 transfer fields + attempts[]) in aperture-voao0.
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

export type RepasseDetail = RepasseListRow & {
  lancamentos: readonly RepasseDetailLancamento[];
};

export type AprovarMutationResult = {
  idRepasse: string;
  aprovadoEm: string;
  numLancamentosTransferidos: number;
  totalCents: number;
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
    rows: query.data?.rows ?? [],
    isLoading: query.isLoading,
    error: query.error ? { message: query.error.message } : null,
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
    data: query.data?.repasse ?? null,
    isLoading: query.isLoading,
    error: query.error ? { message: query.error.message } : null,
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
