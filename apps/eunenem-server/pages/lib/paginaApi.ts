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
import { useCampanhaRota } from "./campanha-rota.js";
import { trpc } from "./trpc.js";

type PaginaInputs = inferRouterInputs<PaginaRouter>;
type PaginaOutputs = inferRouterOutputs<PaginaRouter>;

// ── Contract types (derived from Rex's zod schemas) ───────────────────────

/** Visitor-safe gift projection. NO idCampanha, NO contribuinte PII. */
export type PaginaContribuicao =
  PaginaOutputs["obterListaPresentes"][number];

/**
 * Visitor-safe mural recado (aperture-7eci9). One row per aprovado
 * pagamento whose contribuinte left a mensagem at Stripe checkout.
 * Projection: opaque pagamento id, the nome typed at checkout, the
 * mensagem body, and the criadoEm timestamp. No PII beyond the nome
 * the contribuinte themselves chose to display.
 */
export type PaginaMuralRecado = PaginaOutputs["obterMural"][number];

export type IniciarPagamentoInput = PaginaInputs["iniciarPagamentoContribuicao"];

export type IniciarPagamentoResult =
  PaginaOutputs["iniciarPagamentoContribuicao"];

/** Plan 0017 — multi-item cart checkout input/output (aperture-16flf). */
export type IniciarPagamentoCarrinhoInput =
  PaginaInputs["iniciarPagamentoCarrinho"];

export type IniciarPagamentoCarrinhoResult =
  PaginaOutputs["iniciarPagamentoCarrinho"];

export type ObterSucessoResult = PaginaOutputs["obterSucessoPagamento"];

/** Payment method picker — exactly the enum Rex's router accepts. */
export type MetodoPagamento = IniciarPagamentoInput["metodo"];

/** Status of a Pagamento, surfaced on the success page. */
export type PagamentoStatus = ObterSucessoResult["status"];

// ── Hooks (real tRPC) ─────────────────────────────────────────────────────

/**
 * Visitor read of the public lista de presentes.
 *
 * aperture-1yx1n — resolves the ROUTE campanha (/pagina/:slug/c/:id) so a
 * specific campanha's page shows ITS gifts. Bare URL → no idCampanha →
 * server default (oldest). Same pattern as the painel hooks (PR #353).
 */
export function usePaginaListaPresentes(slug: string) {
  const idCampanha = useCampanhaRota();
  return trpc.pagina.obterListaPresentes.useQuery(
    idCampanha ? { slug, idCampanha } : { slug },
    { staleTime: 30_000 },
  );
}

/**
 * Visitor read of the public mural — aprovado pagamentos with a
 * non-empty mensagem, ordered newest-first. aperture-7eci9.
 *
 * Same 30s staleTime as the gift list so the mural stays roughly
 * fresh without thrashing on every render. Webhook-driven new recados
 * arrive within one staleness window without manual invalidation; a
 * future tick can wire an invalidation hook if real-time freshness
 * becomes necessary.
 */
export function usePaginaMural(slug: string) {
  // aperture-1yx1n — route campanha's mural; bare URL → server default.
  const idCampanha = useCampanhaRota();
  return trpc.pagina.obterMural.useQuery(
    idCampanha ? { slug, idCampanha } : { slug },
    { staleTime: 30_000 },
  );
}

/**
 * Visitor initiates payment — server creates a Stripe embedded checkout
 * session, returns { sessionId, clientSecret }.
 */
export function useIniciarPagamentoContribuicao() {
  // aperture-1yx1n — MONEY write: checkout must target the ROUTE campanha
  // or the payment lands on the oldest one. Signature-preserving wrapper;
  // bare guest URL → no idCampanha → server default (guest back-compat).
  const idCampanha = useCampanhaRota();
  const m = trpc.pagina.iniciarPagamentoContribuicao.useMutation();
  return {
    ...m,
    mutate: ((input, opts) =>
      m.mutate(idCampanha ? { ...input, idCampanha } : input, opts)) as typeof m.mutate,
    mutateAsync: ((input, opts) =>
      m.mutateAsync(idCampanha ? { ...input, idCampanha } : input, opts)) as typeof m.mutateAsync,
  };
}

/**
 * Plan 0017 / aperture-16flf — multi-item cart checkout. Same
 * `{sessionId, clientSecret}` response shape as the single-shot mutation
 * so the embedded Stripe checkout mounts identically downstream.
 */
export function useIniciarPagamentoCarrinho() {
  // aperture-1yx1n — same money-write rule as the single-shot mutation.
  const idCampanha = useCampanhaRota();
  const m = trpc.pagina.iniciarPagamentoCarrinho.useMutation();
  return {
    ...m,
    mutate: ((input, opts) =>
      m.mutate(idCampanha ? { ...input, idCampanha } : input, opts)) as typeof m.mutate,
    mutateAsync: ((input, opts) =>
      m.mutateAsync(idCampanha ? { ...input, idCampanha } : input, opts)) as typeof m.mutateAsync,
  };
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
  opts: { enabled?: boolean; pollWhilePending?: boolean; idCampanha?: string | null } = {},
) {
  // aperture-1yx1n — the success URL carries idCampanha as a QUERY param
  // (server stamps &idCampanha= on success_url at session creation, jlvet
  // #348), NOT a /c/ path segment — so it arrives via opts, not route
  // context. Without it, addressed checkouts fail-closed NOT_FOUND on
  // their own success page.
  return trpc.pagina.obterSucessoPagamento.useQuery(
    opts.idCampanha
      ? { slug, sessionId: sessionId ?? "", idCampanha: opts.idCampanha }
      : { slug, sessionId: sessionId ?? "" },
    {
      enabled: (opts.enabled ?? true) && Boolean(sessionId),
      refetchInterval: opts.pollWhilePending
        ? (query) => {
            const status = query.state.data?.status;
            // aperture-d52he — only 'approved'/'rejected' are terminal. 'pending'
            // AND 'unknown' are BOTH pre-webhook race states (the page can render
            // ~50ms after Pay, the webhook lands ~800ms later), so keep polling
            // through both. Previously 'unknown' stopped the poll, which made a
            // freshly-paid visitor land on "essa sessão já passou".
            if (status === "approved" || status === "rejected") {
              return false;
            }
            // Give-up cap (~30s = 15 × 2s) so a truly-dead sessionId doesn't
            // poll forever; the component shows "sessão expirada" past its own
            // matching deadline.
            if (query.state.dataUpdateCount >= 15) {
              return false;
            }
            return 2000;
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
