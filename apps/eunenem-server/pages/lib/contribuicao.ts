// aperture-0ph83 — Contribuicao adapter (REAL tRPC).
//
// Single seam between the lista UI and the contribuicao data layer.
// SWAPPED from mock → real tRPC by GLaDOS post-PR #68 merge.
//
// Contract (Plan 0016 aperture-putz5 reshape — `qty` row-multiplier
// retired in favor of `quantidade` slot capacity per locked decision #1):
//   contribuicao.list -> ContribuicaoDTO[]
//   contribuicao.create({ nome, valor, imagemUrl, grupo, quantidade }) -> { ids }
//   contribuicao.createBulk({ items: [...] }) -> { ids }
//   contribuicao.update({ id, ...fields, quantidade? }) -> ContribuicaoDTO
//   contribuicao.delete({ ids }) -> { count }
//
// `createFromCatalog` + `createFromListaPronta` were declared in the
// pre-0016 contract but never wired server-side. The corresponding hooks
// (`useContribuicaoCreateFromCatalog`, `useContribuicaoCreateFromListaPronta`)
// were dead client code referencing routes that don't exist; removed in
// this PR. If catalog/lista-pronta convenience procedures land later they
// re-enter through the bulk path.
//
// Errors: BAD_REQUEST 'contribuicao_locked' | NOT_FOUND | UNAUTHORIZED
//         mapped to ContribuicaoError discriminated union.
//
// Invalidation: every mutation invalidates `trpc.contribuicao.list` via
// `trpc.useUtils().contribuicao.list.invalidate()`. Mock-era manual
// queryKey + useQueryClient dropped — trpc-react-query manages its own keys.

import { TRPCClientError } from "@trpc/client";

import {
  type BulkCreateInput,
  type ContribuicaoDTO,
  type CreateInput,
  type DeleteInput,
  type UpdateInput,
} from "./mocks/contribuicao-mock.js";
import { type SemIdCampanha, useCampanhaEscrita } from "./campanha-escrita.js";
import { useCampanhaRota } from "./campanha-rota.js";
import { trpc } from "./trpc.js";

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
 * Translate a thrown tRPC error into the UI's `ContribuicaoError` shape.
 * `TRPCClientError` (from @trpc/client) is the real wire client error type;
 * code lives at `err.data.code`. Anything else collapses to `network` so
 * the user sees a friendly retry instead of a stack trace.
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

/** Duck-typed code extraction. Returns null for non-tRPC errors. */
function extractTrpcCode(err: unknown): string | null {
  if (err instanceof TRPCClientError) {
    return typeof err.data?.code === "string" ? err.data.code : null;
  }
  return null;
}

// ── React Query hooks (real tRPC) ──────────────────────────────────────────
//
// Every mutation invalidates the contribuicao.list query on success
// via trpc.useUtils() — the UI re-fetches and renders the new world.
// No optimistic updates yet (intentionally — match the documented
// pattern; introducing optimistic logic here would couple to a
// pattern that hasn't landed elsewhere in this codebase).

/**
 * Live list query — drives the gift-grid render.
 *
 * aperture-z6vks — the hook resolves the ROUTE campanha itself via
 * useCampanhaRota() so no call site can forget to pass it (the bug class
 * behind snfin/n44wk/z6vks: naked useQuery() → server defaults to the
 * user's oldest campanha, ignoring the clicked /c/:idCampanha). Bare URLs
 * keep back-compat: context undefined → no input → server default.
 */
export function useContribuicaoList() {
  const idCampanha = useCampanhaRota();
  return trpc.contribuicao.list.useQuery(idCampanha ? { idCampanha } : undefined);
}

/** Single-item create. One row with `quantidade=N` per Plan 0016. */
// aperture-1kbyx — writes target the ROUTE campanha; bare URL → explicit
// session-default (oldest) id, so the server can require idCampanha.
export function useContribuicaoCreate() {
  const utils = trpc.useUtils();
  const idCampanha = useCampanhaEscrita();
  const m = trpc.contribuicao.create.useMutation({
    onSuccess: () => {
      void utils.contribuicao.list.invalidate();
    },
  });
  return {
    ...m,
    mutate: ((input, opts) => m.mutate({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutate>,
    mutateAsync: ((input, opts) => m.mutateAsync({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutateAsync>,
  };
}

/**
 * Bulk create — one row per `input.items[i]`, each carrying its own
 * `quantidade` (Plan 0016 single-row + quantidade migration). Pre-0016
 * this fanned out into `items[i].qty` rows per item; that pattern is
 * gone.
 */
// aperture-1kbyx — writes target the ROUTE campanha; bare URL → explicit
// session-default (oldest) id, so the server can require idCampanha.
export function useContribuicaoCreateBulk() {
  const utils = trpc.useUtils();
  const idCampanha = useCampanhaEscrita();
  const m = trpc.contribuicao.createBulk.useMutation({
    onSuccess: () => {
      void utils.contribuicao.list.invalidate();
    },
  });
  return {
    ...m,
    mutate: ((input, opts) => m.mutate({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutate>,
    mutateAsync: ((input, opts) => m.mutateAsync({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutateAsync>,
  };
}

/** Patch a single contribuicao. Throws `locked` on indisponivel rows. */
// aperture-1kbyx — writes target the ROUTE campanha; bare URL → explicit
// session-default (oldest) id, so the server can require idCampanha.
export function useContribuicaoUpdate() {
  const utils = trpc.useUtils();
  const idCampanha = useCampanhaEscrita();
  const m = trpc.contribuicao.update.useMutation({
    onSuccess: () => {
      void utils.contribuicao.list.invalidate();
    },
  });
  return {
    ...m,
    mutate: ((input, opts) => m.mutate({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutate>,
    mutateAsync: ((input, opts) => m.mutateAsync({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutateAsync>,
  };
}

/** Bulk delete by ids. Missing ids are silently skipped. */
// aperture-1kbyx — writes target the ROUTE campanha; bare URL → explicit
// session-default (oldest) id, so the server can require idCampanha.
export function useContribuicaoDelete() {
  const utils = trpc.useUtils();
  const idCampanha = useCampanhaEscrita();
  const m = trpc.contribuicao.delete.useMutation({
    onSuccess: () => {
      void utils.contribuicao.list.invalidate();
    },
  });
  return {
    ...m,
    mutate: ((input, opts) => m.mutate({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutate>,
    mutateAsync: ((input, opts) => m.mutateAsync({ ...input, idCampanha: idCampanha ?? '' }, opts)) as SemIdCampanha<typeof m.mutateAsync>,
  };
}
