// aperture-3xgch — boundary layer for the public /pagina/<slug> tRPC procs.
//
// WHY THIS FILE EXISTS (the seam):
// Rex's sibling bead aperture-vkrkm ships the real `pagina` tRPC router with
// three public (unauthed) procedures: obterListaPresentes, iniciarPagamento-
// Contribuicao, obterSucessoPagamento. Until that PR lands, this file
// returns stub data derived from the existing GIFTS mock so the visitor
// marketplace + checkout modal + success page can be wired against a stable
// contract NOW — per specialist-delegation §9 (parallel tracks, don't wait
// for a dependency you can scaffold against).
//
// WHEN REX'S PR LANDS:
//   - Delete the STUB section
//   - Swap each hook body to call trpc.pagina.X.useQuery / useMutation
//   - Re-export the inferred types from his router via
//     `type RouterOutputs = inferRouterOutputs<AppRouter>`
//   - Marketplace.tsx + GiftCheckoutModal.tsx + PaginaSucessoPage.tsx don't
//     change at all — they consume this file's hook signatures.
//
// The contract shape here MIRRORS the bead spec for aperture-vkrkm:
//   { id, nome, valor (cents), imagemUrl, grupo, status }
//   iniciar → { clientSecret, sessionId }
//   sucesso → { giftName, valor, recadinho, babyName, status, contribuinte }

import { useMutation, useQuery } from "@tanstack/react-query";
import { GIFTS } from "@/lib/mocks/gifts";

// ── Contract types (mirror Rex's vkrkm zod schemas) ───────────────────────

/** Visitor-safe gift projection. NO idCampanha, NO contribuinte PII. */
export interface PaginaContribuicao {
  id: string;
  nome: string;
  valor: number; // cents
  imagemUrl: string | null;
  grupo: string | null;
  status: "disponivel" | "indisponivel";
}

export interface IniciarPagamentoInput {
  slug: string;
  idContribuicao: string;
  contribuinte: {
    nome: string;
    email: string;
  };
}

export interface IniciarPagamentoResult {
  clientSecret: string;
  sessionId: string;
}

export type PagamentoStatus = "approved" | "pending" | "failed" | "expired";

export interface ObterSucessoResult {
  giftName: string;
  valor: number; // cents
  recadinho: string | null;
  babyName: string;
  status: PagamentoStatus;
  contribuinte: {
    nome: string;
  };
}

// ── STUB section — DELETE when Rex's vkrkm lands ──────────────────────────

const STUB_GROUPS = ["Mamadeiras", "Banho", "Quartinho", "Sono", "Passeio", "Fralda", "Brincar", "Saúde"];

function stubContribuicoes(): PaginaContribuicao[] {
  // Convert the legacy Gift[] shape to the new PaginaContribuicao shape so
  // the UI renders with familiar data during scaffold mode.
  return GIFTS.map((g, idx) => ({
    id: g.id,
    nome: g.name,
    valor: g.priceBRL * 100, // BRL → cents
    imagemUrl: null,
    // Map the legacy English-ish categories to lowercase grupos similar to
    // what painel writes. Visitor card derives bg + chips off these.
    grupo: STUB_GROUPS[idx % STUB_GROUPS.length] ?? null,
    status: g.status === "presenteado" ? "indisponivel" : "disponivel",
  }));
}

// ── Hooks (scaffold mode — swap bodies when Rex lands) ────────────────────

/**
 * Visitor read of the public lista de presentes.
 *
 * REAL implementation (post-vkrkm):
 *   return trpc.pagina.obterListaPresentes.useQuery({ slug });
 */
export function usePaginaListaPresentes(slug: string) {
  return useQuery({
    queryKey: ["pagina", "obterListaPresentes", slug],
    queryFn: async () => {
      // Tiny artificial latency to exercise the skeleton state once during
      // local QA. Remove (or leave — it's harmless) when swapping to real.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return stubContribuicoes();
    },
    staleTime: 30_000,
  });
}

/**
 * Visitor initiates payment — server creates a Stripe embedded checkout
 * session, returns clientSecret + sessionId.
 *
 * REAL implementation (post-vkrkm):
 *   return trpc.pagina.iniciarPagamentoContribuicao.useMutation();
 */
export function useIniciarPagamentoContribuicao() {
  return useMutation<IniciarPagamentoResult, Error, IniciarPagamentoInput>({
    mutationFn: async (_input) => {
      // Stub: pretend to call the backend. Returns a fake clientSecret that
      // Stripe will reject — but the UI path (form → mutation → mount Stripe)
      // is exercised. When Rex lands, real Stripe sessions flow through.
      await new Promise((resolve) => setTimeout(resolve, 600));
      throw new Error(
        "stripe_not_wired_yet — Rex's aperture-vkrkm + aperture-xaha2 must land before payment can complete. The frontend form path is wired and ready.",
      );
    },
  });
}

/**
 * Success-page read — used by aperture-xh4jk (sibling bead C5). Resolves a
 * Stripe session and returns the gift + recadinho + status.
 *
 * REAL implementation (post-vkrkm):
 *   return trpc.pagina.obterSucessoPagamento.useQuery(
 *     { slug, sessionId },
 *     { refetchInterval: opts.refetchInterval },
 *   );
 */
export function useObterSucessoPagamento(
  slug: string,
  sessionId: string,
  opts: { refetchInterval?: number | false } = {},
) {
  return useQuery<ObterSucessoResult>({
    queryKey: ["pagina", "obterSucessoPagamento", slug, sessionId],
    queryFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Stub: pretend the payment was approved with the first gift from the
      // mock so the success-page craft can be designed against real shapes.
      const first = GIFTS[0];
      return {
        giftName: first?.name ?? "Presente",
        valor: (first?.priceBRL ?? 0) * 100,
        recadinho: "Mandando muito amor pro neném ♡",
        babyName: "neném",
        status: "approved",
        contribuinte: { nome: "Visitante" },
      };
    },
    refetchInterval: opts.refetchInterval ?? false,
    staleTime: 5_000,
  });
}
