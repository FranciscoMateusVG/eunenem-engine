// aperture-3xgch (scaffold) + aperture-ra027 (stub→real flip).
//
// Boundary layer for the public /pagina/<slug> tRPC procs. Now points at
// Rex's real `pagina` router (aperture-vkrkm + aperture-xaha2 +
// aperture-24n36 — all merged 2026-05-31). The stub section is gone;
// the types here are derived from RouterInputs/RouterOutputs so they
// stay in sync with the server contract on every typecheck.
//
// Marketplace.tsx, GiftCheckoutModal.tsx, and PaginaSucessoPage.tsx
// consume this file's hook signatures. The contract delta from the
// scaffold:
//   - status enum: 'pending' | 'approved' | 'rejected' | 'unknown'
//     (was: 'approved' | 'pending' | 'failed' | 'expired')
//   - contribuinte: { nome: string|null, email: string|null }
//     (was: { nome: string })
//   - IniciarPagamentoInput now requires `metodo: 'pix' | 'credit_card'`

import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { PaginaRouter } from "../../server/trpc/pagina-router.js";
import { trpc } from "./trpc.js";

type PaginaInputs = inferRouterInputs<PaginaRouter>;
type PaginaOutputs = inferRouterOutputs<PaginaRouter>;

// ── Contract types (derived from Rex's zod schemas) ───────────────────────

/** Visitor-safe gift projection. NO idCampanha, NO contribuinte PII. */
export type PaginaContribuicao =
  PaginaOutputs["obterListaPresentes"][number];

export type IniciarPagamentoInput = PaginaInputs["iniciarPagamentoContribuicao"];

export type IniciarPagamentoResult =
  PaginaOutputs["iniciarPagamentoContribuicao"];

export type ObterSucessoResult = PaginaOutputs["obterSucessoPagamento"];

/** Payment method picker — exactly the enum Rex's router accepts. */
export type MetodoPagamento = IniciarPagamentoInput["metodo"];

/** Status of a Pagamento, surfaced on the success page. */
export type PagamentoStatus = ObterSucessoResult["status"];

// ── Hooks (real tRPC) ─────────────────────────────────────────────────────

/**
 * Visitor read of the public lista de presentes.
 */
export function usePaginaListaPresentes(slug: string) {
  return trpc.pagina.obterListaPresentes.useQuery(
    { slug },
    { staleTime: 30_000 },
  );
}

/**
 * Visitor initiates payment — server creates a Stripe embedded checkout
 * session, returns { sessionId, clientSecret }.
 */
export function useIniciarPagamentoContribuicao() {
  return trpc.pagina.iniciarPagamentoContribuicao.useMutation();
}

/**
 * Success-page read — resolves a Stripe session and returns the gift +
 * recadinho + status + contribuinte.
 *
 * Two opt flags:
 *   - `enabled` (default true) — gate the query for cases like SSR where
 *     sessionId can't be read yet (window.location). Combined with the
 *     intrinsic Boolean(sessionId) check.
 *   - `pollWhilePending` (default false) — when true, status='pending' auto-
 *     refetches every 3s; clears once the webhook flips status to a terminal
 *     value (approved | rejected | unknown).
 */
export function useObterSucessoPagamento(
  slug: string,
  sessionId: string | null,
  opts: { enabled?: boolean; pollWhilePending?: boolean } = {},
) {
  return trpc.pagina.obterSucessoPagamento.useQuery(
    { slug, sessionId: sessionId ?? "" },
    {
      enabled: (opts.enabled ?? true) && Boolean(sessionId),
      refetchInterval: opts.pollWhilePending
        ? (query) => {
            const status = query.state.data?.status;
            if (
              status === "approved" ||
              status === "rejected" ||
              status === "unknown"
            ) {
              return false;
            }
            return 3000;
          }
        : false,
      staleTime: 5_000,
      retry: 1,
    },
  );
}

/**
 * Invalidate the visitor's lista de presentes cache so the gift grid
 * (Marketplace) refetches and shows the just-purchased gift as PRESENTEADO.
 * Returns a function the caller invokes when a webhook-finalized purchase
 * has been confirmed (e.g. modal phase → completed_confirmed).
 *
 * aperture-6g58e walkthrough caught the staleness: 30s staleTime + no
 * post-purchase invalidation meant the grid stayed stale until manual
 * refresh. This closes that gap without dropping the 30s staleTime for
 * the page's idle reads.
 */
export function useInvalidarListaPresentes() {
  const utils = trpc.useUtils();
  return (slug: string) => utils.pagina.obterListaPresentes.invalidate({ slug });
}
