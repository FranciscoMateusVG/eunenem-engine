import { TRPCClientError } from "@trpc/client";
import { trpc } from "@/lib/trpc.js";

/**
 * Extrato data layer — plan q2d4b Track 4 (post-swap).
 *
 * Rex's Track 2 backend (aperture-7g5sx, PR #147) is LIVE. This module
 * previously shipped djb2-seeded stubs against the locked contract; now
 * the hook bodies call real trpc procs and the fixtures are gone.
 *
 * Procs in play (all under `trpc.recebedor.*`):
 *   - extrato.summary({ idCampanha })            → query
 *   - extrato.list({ idCampanha, statusFilters, cursor, limit }) → query
 *   - transferencia.solicitar({ idCampanha })    → mutation
 *
 * Auth: session-cookie based, recebedor-router's `resolveAdminOfCampanha`
 * enforces that the caller's session.idConta is in
 * campanha.idsAdministradores. Wrong-tenant / missing-session surfaces
 * UNAUTHORIZED (not NOT_FOUND — no existence leak).
 *
 * slug → idCampanha resolution: piggybacks on `trpc.auth.me()`, which
 * already returns `{ idCampanha, idOpcaoPresentes }` for the authenticated
 * user (aperture-p8i01). The slug parameter is currently informational
 * (the painel routes use slug for the URL; the actual data binds to the
 * authenticated user's default campanha). For multi-campanha futures the
 * slug → idCampanha mapping needs a real proc that resolves slug to a
 * specific campanha; v1 assumes one-campanha-per-user.
 */

// ── Locked contract types (mirror Rex's exports) ────────────────────────────
//
// Kept LOCAL to this module rather than imported from the server router so
// the frontend bundle doesn't pull in server-only deps via the router file
// path. Shapes match `recebedor-router.ts` verbatim; if drift surfaces here
// at typecheck time, fix the local types — they're the canonical projection
// of what the wire actually ships.

export type ExtratoLiberacao =
  | "aguardando_liberacao"
  | "disponivel"
  // aperture-1ut92 — admin-pipeline state: lancamento claimed by a
  // solicitado repasse, awaiting admin approval. Wire ships this now;
  // visual treatment (color/label) is Vance's parallel-prep PR.
  | "solicitado"
  | "transferido"
  | "cancelado";

export type ExtratoSummaryDTO = {
  totalRecebidoCents: number;
  resgatadoCents: number;
  /** Money the recebedor can still SOLICITAR right now. Shrinks at solicit-
   *  time — solicitado lançamentos move out of this bucket into
   *  aguardandoAprovacaoCents (aperture-1ut92). Operator's mental model:
   *  "saldo I can act on right now." */
  saldoDisponivelCents: number;
  aguardandoLiberacaoCents: number;
  /** Sum of lançamentos with idRepasse set + still untransferred
   *  (aperture-1ut92, Rex backend PR #158). Money is requested for transfer
   *  and sitting in the admin-approval queue. Distinct visual bucket from
   *  saldoDisponivel (actionable) and aguardandoLiberacao (waiting Stripe
   *  maturação). Optional on the mirror for the trpc-cache-rotation window
   *  — older cached responses lack this field; renderer falls back to 0. */
  aguardandoAprovacaoCents?: number;
  proximaTransfDate: string | null;
  totalPresentes: number;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
};

export type ExtratoRowDTO = {
  idLancamento: string;
  idPagamento: string;
  contribuinteNome: string | null;
  amountCents: number;
  liberacao: ExtratoLiberacao;
  timestamp: string;
  /** ISO of the FUTURE date when the row's funds become available. Renamed
   *  from `liberadoEm` post-aperture-75mw3 — the field is a predicted
   *  release date, not a past-tense observation. Wire ships string when
   *  liberacao=aguardando_liberacao + parent pagamento has
   *  balanceTransactionAvailableOn; null otherwise. */
  liberacaoPrevistaEm: string | null;
  /** Gift name resolved via lancamento → pagamento.intencao.idContribuicao
   *  → contribuição.nome (aperture-k6fbz, Rex backend merged at ed459fd).
   *  Empty string when the contribuição was deleted between pagamento +
   *  read. Optional in the mirror so the swap survives the merge window
   *  (the field arrived on the wire 2026-06-04; older cached responses
   *  may briefly lack it until the trpc cache rotates). Consumer defends
   *  with `|| "lançamento"` for both the empty-string + absence cases. */
  contribuicaoNome?: string;
  /** Gift image — emoji glyph OR hosted URL (aperture-k6fbz). Null when
   *  the contribuição has no image OR was deleted post-pagamento.
   *  Optional in the mirror for the same merge-window reason as
   *  contribuicaoNome above. */
  contribuicaoImagemUrl?: string | null;
};

export type SolicitarTransferenciaResult = {
  idRepasse: string;
  amountCents: number;
  solicitadoEm: string;
  numLancamentos: number;
};

// ── Hook-shaped surface (real trpc calls) ───────────────────────────────────

export type ExtratoSummaryResult = {
  data: ExtratoSummaryDTO | null;
  isLoading: boolean;
  error: { message: string } | null;
};

export type ExtratoListResult = {
  rows: readonly ExtratoRowDTO[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type ExtratoListResultHook = {
  data: ExtratoListResult | null;
  isLoading: boolean;
  error: { message: string } | null;
};

export type SolicitarTransferenciaState = {
  mutate: () => void;
  isPending: boolean;
  data: SolicitarTransferenciaResult | null;
  error: { code: string; message: string } | null;
  reset: () => void;
};

export function useStubExtratoSummary(
  idCampanha: string,
): ExtratoSummaryResult {
  const query = trpc.recebedor.extrato.summary.useQuery(
    { idCampanha },
    { enabled: idCampanha !== "" && isUuid(idCampanha) },
  );
  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ? { message: query.error.message } : null,
  };
}

export function useStubExtratoList(input: {
  idCampanha: string;
  statusFilters?: ExtratoLiberacao[];
  cursor?: string | null;
  limit?: number;
}): ExtratoListResultHook {
  // Rex's input schema:
  //   statusFilters → enum subset (no 'cancelado' — operator never filters
  //                                for cancelled; we strip it client-side
  //                                if any leak through). aperture-1ut92
  //                                added 'solicitado' to the accepted set.
  //   cursor       → string | null (required slot, even when null)
  //   limit        → 1..100 (default 20). Use 100 so the current "filter
  //                  client-side" approach has enough data without paging.
  const wireFilters = (input.statusFilters ?? []).filter(
    (
      s,
    ): s is
      | "aguardando_liberacao"
      | "disponivel"
      | "solicitado"
      | "transferido" => s !== "cancelado",
  );
  const query = trpc.recebedor.extrato.list.useQuery(
    {
      idCampanha: input.idCampanha,
      statusFilters: wireFilters,
      cursor: input.cursor ?? null,
      limit: input.limit ?? 100,
    },
    { enabled: input.idCampanha !== "" && isUuid(input.idCampanha) },
  );
  return {
    data: query.data
      ? {
          // Per-row remap. The wire (Rex's recebedor-router) is in the
          // middle of renaming `liberadoEm` → `liberacaoPrevistaEm` per
          // aperture-75mw3. Until his rename PR merges, the inferred trpc
          // type still has `liberadoEm`. Read EITHER field via the
          // bridge below; expose the new name on our DTO. When his PR
          // lands, the `?? r.liberadoEm` fallback becomes a one-line
          // cleanup target.
          rows: query.data.rows.map((r): ExtratoRowDTO => {
            const renamed = r as { liberacaoPrevistaEm?: string | null };
            const legacy = r as { liberadoEm?: string | null };
            const liberacaoPrevistaEm =
              renamed.liberacaoPrevistaEm !== undefined
                ? renamed.liberacaoPrevistaEm
                : (legacy.liberadoEm ?? null);
            // aperture-k6fbz — gift name + image arrived on the wire
            // 2026-06-04 (Rex's PR merged at ed459fd). Optional-read so
            // any cached response from before the merge still parses;
            // consumer defends against empty-string contribuicaoNome
            // (deleted-contribuição edge case) with `|| "lançamento"`.
            const giftCarrier = r as {
              contribuicaoNome?: unknown;
              contribuicaoImagemUrl?: unknown;
            };
            const contribuicaoNome =
              typeof giftCarrier.contribuicaoNome === "string"
                ? giftCarrier.contribuicaoNome
                : undefined;
            const contribuicaoImagemUrl =
              typeof giftCarrier.contribuicaoImagemUrl === "string"
                ? giftCarrier.contribuicaoImagemUrl
                : giftCarrier.contribuicaoImagemUrl === null
                  ? null
                  : undefined;
            return {
              idLancamento: r.idLancamento,
              idPagamento: r.idPagamento,
              contribuinteNome: r.contribuinteNome,
              amountCents: r.amountCents,
              liberacao: r.liberacao,
              timestamp: r.timestamp,
              liberacaoPrevistaEm,
              contribuicaoNome,
              contribuicaoImagemUrl,
            };
          }),
          nextCursor: query.data.nextCursor,
          hasMore: query.data.hasMore,
        }
      : null,
    isLoading: query.isLoading,
    error: query.error ? { message: query.error.message } : null,
  };
}

export function useStubSolicitarTransferencia(opts: {
  /** Resolved idCampanha for the authenticated user. Captured in closure
   *  for the mutate() call so consumers can call mutate() with no args
   *  (matches the stub API shape). */
  idCampanha: string | null;
  onSuccess: (result: SolicitarTransferenciaResult) => void;
}): SolicitarTransferenciaState {
  const utils = trpc.useUtils();
  const mutation = trpc.recebedor.transferencia.solicitar.useMutation({
    onSuccess: async (result) => {
      // Refresh the data the operator just changed. Invalidate before the
      // consumer-onSuccess so re-renders pick up fresh queries.
      await Promise.all([
        utils.recebedor.extrato.summary.invalidate(),
        utils.recebedor.extrato.list.invalidate(),
      ]);
      opts.onSuccess(result);
    },
  });
  // Discriminate domain errors per the locked contract:
  //   CONFLICT + 'repasse_ja_pendente'        → button disabled + label
  //   UNPROCESSABLE_CONTENT + 'saldo_insuf…'  → button disabled + label
  //   else (BAD_REQUEST / UNAUTHORIZED / etc.) → generic operator label
  const error: { code: string; message: string } | null =
    mutation.error && mutation.error instanceof TRPCClientError
      ? { code: extractCode(mutation.error), message: mutation.error.message }
      : mutation.error
        ? { code: "INTERNAL_SERVER_ERROR", message: mutation.error.message }
        : null;
  return {
    mutate: () => {
      // No-op if idCampanha hasn't resolved yet. The consumer gates the
      // modal-open state on the loading check upstream, but the defensive
      // null-check here keeps a stray race from firing a malformed call.
      if (opts.idCampanha !== null) {
        mutation.mutate({ idCampanha: opts.idCampanha });
      }
    },
    isPending: mutation.isPending,
    data: mutation.data ?? null,
    error,
    reset: () => mutation.reset(),
  };
}

/**
 * slug → idCampanha resolution via the authenticated user's session.
 * `trpc.auth.me()` already returns `idCampanha` for the current user's
 * default campanha (aperture-p8i01). v1 assumes one-campanha-per-user;
 * a future multi-campanha world will need a real slug-keyed lookup.
 *
 * The `slug` param is informational v1 — we don't currently use it to
 * disambiguate. If the authenticated session's slug doesn't match the
 * URL slug, the wire still resolves to the session-user's campanha
 * (defensive). Operator visiting their own painel URL while logged in
 * sees their own data.
 */
export function useStubCampanhaIdForSlug(_slug: string): {
  idCampanha: string | null;
  /**
   * Whether the authenticated user has a recebedor configured on the
   * default campanha. Drives the TransferModal's onboarding-vs-confirm
   * branch (aperture-kbmel + aperture-jtamj swap-over).
   *
   * Real source: trpc.auth.me carries `hasRecebedor: boolean` (Rex's
   * Phase A #193 — derived from campanha?.idRecebedor != null with no
   * extra DB call). Null campanha (pre-p8i01 backfill caveat) AND
   * null recebedor both surface as false, both routing to the onboarding
   * embed.
   */
  hasRecebedor: boolean;
  isLoading: boolean;
  error: { message: string } | null;
} {
  const me = trpc.auth.me.useQuery();
  return {
    idCampanha: me.data?.idCampanha ?? null,
    hasRecebedor: me.data?.hasRecebedor ?? false,
    isLoading: me.isLoading,
    error: me.error ? { message: me.error.message } : null,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Lazy UUID check — Rex's input schema validates `idCampanha` as
 * `z.string().uuid()`. We block the query early when the resolved
 * idCampanha is empty or non-UUID shape (the `auth.me()` user may have
 * idCampanha === null during backfill).
 */
function isUuid(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    s,
  );
}

/**
 * Best-effort TRPCError code extraction. The shape carried on
 * `TRPCClientError.data.code` is the string code (CONFLICT,
 * UNPROCESSABLE_CONTENT, etc.). When the transformer chain
 * sanitizes the error, the code may be on `.shape.data.code` instead
 * — we check both.
 */
function extractCode(err: TRPCClientError<never>): string {
  const dataCode = (err.data as { code?: unknown } | null | undefined)?.code;
  if (typeof dataCode === "string") return dataCode;
  const shapeCode = (
    err.shape as
      | { data?: { code?: unknown } }
      | null
      | undefined
  )?.data?.code;
  if (typeof shapeCode === "string") return shapeCode;
  return "INTERNAL_SERVER_ERROR";
}
