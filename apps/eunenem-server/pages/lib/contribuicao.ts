// aperture-0ph83 — Contribuicao adapter.
//
// Single seam between the lista UI and the contribuicao data layer.
// Currently re-exports a MOCK implementation (lib/mocks/contribuicao-mock.ts)
// so the UI can be built and tested against the locked contract while
// Rex's tRPC procedures (aperture-d6atj, PR #68) finish merging.
//
// SWAP: when PR #68 merges, flip the internals of this file to:
//   const trpc = useTrpc(); // however the client surface is named
//   return trpc.contribuicao.list.useQuery();
// (etc for each hook). The export surface stays identical, so
// ListaPresentesBody.tsx never changes.
//
// Contract Rex's d6atj ships (LOCKED — see aperture-0ph83 BEADS notes):
//   contribuicao.list -> ContribuicaoDTO[]
//   contribuicao.create({ nome, valor, imagemUrl, grupo, qty }) -> { ids }
//   contribuicao.createBulk({ items: [...] }) -> { ids }
//   contribuicao.createFromCatalog({ catalogItemId, qty, overrides? }) -> { ids }
//   contribuicao.createFromListaPronta({ listaProntaId }) -> { ids }
//   contribuicao.update({ id, ...fields }) -> { id }
//   contribuicao.delete({ ids }) -> { count }
//
// Errors: BAD_REQUEST 'contribuicao_locked' | NOT_FOUND | UNAUTHORIZED
//         mapped to ContribuicaoError discriminated union.

import { TRPCClientError } from "@trpc/client";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import {
  mockContribuicao,
  type BulkCreateInput,
  type ContribuicaoDTO,
  type CreateInput,
  type DeleteInput,
  type UpdateInput,
} from "./mocks/contribuicao-mock.js";

// ── Re-exported contract types ─────────────────────────────────────────────

export type {
  BulkCreateInput,
  ContribuicaoDTO,
  CreateInput,
  DeleteInput,
  UpdateInput,
};

// ── Money helpers ──────────────────────────────────────────────────────────

/** BRL float (49.9) → cents (4990). Source of truth for write paths. */
export function centsFromBRL(brl: number): number {
  return Math.round(brl * 100);
}

/** Cents (4990) → BRL float (49.9). For display formatters. */
export function brlFromCents(cents: number): number {
  return cents / 100;
}

// ── bgColor derivation ─────────────────────────────────────────────────────
//
// UI-only token mapping derived from LISTA_PRESENTES_SEED's
// category-to-bgColor recipe (aperture-4je0p): the seed picks a
// canonical tint per category, and we replicate that here so server
// rows (which only carry `grupo`, not `bgColor`) render with the
// same palette without a round-trip lookup.
//
// `passeio` is absent from the seed (no demo row uses it) — fall back
// on the most-common catalog tint for that category (peach-soft).

const CATEGORY_BG_COLOR: Record<string, string> = {
  fraldas: "var(--lilac-soft)",
  higiene: "var(--pink-soft)",
  roupa: "var(--pink-soft)",
  soninho: "var(--lilac-soft)",
  alimentacao: "var(--blue)",
  passeio: "var(--peach-soft)",
  personalizado: "var(--cream-2)",
};

/**
 * Resolve a `grupo` tag to a background-color token. Unknown groups
 * (custom user-entered values, or bundle ids like "essenciais" that
 * don't appear in ListaCategory) fall back to the lilac soft tint.
 */
export function deriveBgColor(grupo: string | null): string {
  if (grupo === null) return "var(--lilac-soft)";
  return CATEGORY_BG_COLOR[grupo] ?? "var(--lilac-soft)";
}

// ── Error mapping ──────────────────────────────────────────────────────────

/** Discriminated error type so the UI can render the right toast. */
export type ContribuicaoError =
  | { kind: "locked" }
  | { kind: "not-found" }
  | { kind: "unauthorized" }
  | { kind: "network" };

/** pt-BR friendly message per error kind. */
export function contribuicaoErrorMessage(err: ContribuicaoError): string {
  switch (err.kind) {
    case "locked":
      return "esse mimo já foi reservado, não dá pra mudar agora ♡";
    case "not-found":
      return "esse mimo não existe mais";
    case "unauthorized":
      return "sem permissão pra essa ação";
    case "network":
      return "deu ruim na conexão — tenta de novo daqui a pouco ♡";
  }
}

/**
 * Translate a thrown tRPC error into the UI's `ContribuicaoError`
 * shape. Handles BOTH error sources we'll see across the swap:
 *   - `TRPCClientError` (from @trpc/client) — what the real wire client
 *     throws when the swap lands. Code lives at `err.data.code`.
 *   - `TRPCError` (from @trpc/server) — what the mock throws inline
 *     during the in-flight period before PR #68 merges. Code lives at
 *     `err.code` directly.
 * Anything else collapses to `network` so the user sees a friendly
 * retry instead of a stack trace.
 */
export function toContribuicaoError(err: unknown): ContribuicaoError {
  const code = extractTrpcCode(err);
  const message = err instanceof Error ? err.message : "";
  switch (code) {
    case "BAD_REQUEST":
      if (message.includes("contribuicao_locked")) {
        return { kind: "locked" };
      }
      return { kind: "network" };
    case "NOT_FOUND":
      return { kind: "not-found" };
    case "UNAUTHORIZED":
      return { kind: "unauthorized" };
    default:
      return { kind: "network" };
  }
}

/**
 * Duck-typed code extraction across both TRPCClientError and TRPCError
 * shapes. Returns null for non-tRPC errors.
 */
function extractTrpcCode(err: unknown): string | null {
  if (err instanceof TRPCClientError) {
    return typeof err.data?.code === "string" ? err.data.code : null;
  }
  // TRPCError (server-side) carries `.code` directly. We don't `instanceof`
  // it to avoid importing @trpc/server into the client bundle solely for
  // a type guard the mock will use.
  if (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    return (err as { code: string }).code;
  }
  return null;
}

// ── React Query hooks ──────────────────────────────────────────────────────
//
// Every mutation invalidates the list query on success — the UI
// re-fetches and renders the new world. No optimistic updates yet
// (d0x1w's optimistic pattern is documented but not shipped in this
// codebase; introducing it here would couple the swap-to-real change
// to a pattern that hasn't landed). When PR #68 merges, the internals
// flip from `mockContribuicao.*` to `trpc.contribuicao.*.useMutation`
// and the query key + invalidation strategy stays identical.

const CONTRIBUICAO_LIST_KEY = ["contribuicao.list"] as const;

/** Live list query — drives the gift-grid render. */
export function useContribuicaoList(): UseQueryResult<ContribuicaoDTO[], Error> {
  return useQuery({
    queryKey: CONTRIBUICAO_LIST_KEY,
    queryFn: () => mockContribuicao.list(),
  });
}

/** Single-item create. Multiplied by `input.qty` server-side. */
export function useContribuicaoCreate(): UseMutationResult<
  { ids: string[] },
  Error,
  CreateInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInput) => mockContribuicao.create(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONTRIBUICAO_LIST_KEY });
    },
  });
}

/** Bulk create — each input.items[i] gets `items[i].qty` rows. */
export function useContribuicaoCreateBulk(): UseMutationResult<
  { ids: string[] },
  Error,
  BulkCreateInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkCreateInput) => mockContribuicao.createBulk(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONTRIBUICAO_LIST_KEY });
    },
  });
}

/** Add `qty` units of one catalog item, with optional overrides. */
export function useContribuicaoCreateFromCatalog(): UseMutationResult<
  { ids: string[] },
  Error,
  { catalogItemId: string; qty: number; overrides?: Partial<CreateInput> }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      catalogItemId: string;
      qty: number;
      overrides?: Partial<CreateInput>;
    }) => mockContribuicao.createFromCatalog(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONTRIBUICAO_LIST_KEY });
    },
  });
}

/** Expand a "lista pronta" bundle into individual contribuicoes. */
export function useContribuicaoCreateFromListaPronta(): UseMutationResult<
  { ids: string[] },
  Error,
  { listaProntaId: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { listaProntaId: string }) =>
      mockContribuicao.createFromListaPronta(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONTRIBUICAO_LIST_KEY });
    },
  });
}

/** Patch a single contribuicao. Throws `locked` on indisponivel rows. */
export function useContribuicaoUpdate(): UseMutationResult<
  { id: string },
  Error,
  UpdateInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateInput) => mockContribuicao.update(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONTRIBUICAO_LIST_KEY });
    },
  });
}

/** Bulk delete by ids. Missing ids are silently skipped. */
export function useContribuicaoDelete(): UseMutationResult<
  { count: number },
  Error,
  DeleteInput
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeleteInput) => mockContribuicao.delete(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CONTRIBUICAO_LIST_KEY });
    },
  });
}
