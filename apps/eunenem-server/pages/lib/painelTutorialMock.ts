// aperture-7nius — Tutorial status mock hook + shared response schema.
//
// Plan 0018 §"Shared zod schema (contract pin)" reserves a TutorialStatus
// response shape for the upcoming `trpc.usuario.tutorialStatus` query and
// `trpc.usuario.completarTutorial` mutation (Rex's Phase A, in-flight).
//
// This file ships the FRONTEND-only seam (Phase B):
//
//   1. `TutorialStatusResponseSchema` — the canonical zod shape both Rex's
//      tRPC procedures and Vance's React Query hooks will import once Rex's
//      PR lands. We pin it here so the overlay binds against the final
//      shape — no rewrites at integration time.
//
//   2. `useTutorialStatusMock` + `useCompletarTutorialMock` — temporary
//      stand-ins shaped exactly like react-query's `useQuery` / `useMutation`
//      results. The painel root imports these; at integration time the only
//      change is the import line:
//
//          // before (this file)
//          const status = useTutorialStatusMock();
//          // after (Rex's tRPC live)
//          const status = trpc.usuario.tutorialStatus.useQuery();
//
//      Same call shape, same `.data` field, same `.mutate()` signature —
//      no component rewrites.
//
// DELETE this file when Rex's procedures land and the painel switches to
// `trpc.usuario.tutorialStatus.useQuery()` / `.completarTutorial.useMutation()`.
// At that point the schema can move to `src/observability/dtos/` per plan
// 0018, where the tRPC procedure imports it for `.output()`.

import { z } from "zod";

/**
 * Plan 0018 — shape of `usuario.tutorialStatus` query response AND
 * `usuario.completarTutorial` mutation response. Single source of truth
 * shared by the tRPC procedure (Rex) and the React client (Vance).
 */
export const TutorialStatusResponseSchema = z.object({
  tutorialCompletadoEm: z.string().datetime().nullable(),
  completado: z.boolean(),
});

export type TutorialStatusResponse = z.infer<typeof TutorialStatusResponseSchema>;

/**
 * Shape mirrors `trpc.usuario.tutorialStatus.useQuery()` — only `.data`
 * is consumed by callers today. Returning a typed object (not a bare
 * value) means the swap to the real hook is one-line.
 */
export interface TutorialStatusQueryResult {
  readonly data: TutorialStatusResponse | undefined;
  readonly isLoading: boolean;
}

/**
 * Always returns `{ completado: false }` so any local-dev visit auto-opens
 * the tutorial. Manual override via `?tutorial=skip` query string flips it
 * to `completado: true` so painel work isn't blocked by a forever-popup.
 *
 * NOTE: server-render paths see `completado: false` too — the overlay
 * itself is rendered client-only (it reads `document.querySelector` in
 * an effect; the initial server paint is just the painel).
 */
export function useTutorialStatusMock(): TutorialStatusQueryResult {
  // Read once at module init — no need for React state. The mock is
  // deterministic per page-load.
  const completado =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("tutorial") === "skip";

  return {
    data: {
      tutorialCompletadoEm: completado ? new Date().toISOString() : null,
      completado,
    },
    isLoading: false,
  };
}

/**
 * Shape mirrors `trpc.usuario.completarTutorial.useMutation()` — only
 * `.mutate()` is consumed today. No-op locally.
 */
export interface TutorialCompletarMutationResult {
  readonly mutate: () => void;
  readonly isPending: boolean;
}

export function useCompletarTutorialMock(): TutorialCompletarMutationResult {
  return {
    mutate: () => {
      // Mock: no-op. Real hook will write tutorialCompletadoEm via tRPC.
      if (typeof console !== "undefined") {
        console.info(
          "[painel-tutorial mock] completarTutorial.mutate() — no-op until Rex's tRPC lands.",
        );
      }
    },
    isPending: false,
  };
}
