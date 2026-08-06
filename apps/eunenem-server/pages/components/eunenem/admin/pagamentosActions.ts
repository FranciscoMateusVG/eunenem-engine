// aperture-4uvgf — admin refund action hooks (the UI half of B6's estorno
// machinery). Mirrors the RepassesStubData.ts convention: mutations are
// wrapped in use* hooks that invalidate the reads whose data they change,
// so every pagamento surface (contribuição list, campanha table, detail
// page) re-renders the post-estorno status without manual refresh.

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/trpc/router.js";
import { trpc } from "@/lib/trpc.js";

type AdminOutputs = inferRouterOutputs<AppRouter>["admin"];

/** Result of admin.pagamentos.estornar — the ACTUAL refund outcome. */
export type EstornarPagamentoResult = AdminOutputs["pagamentos"]["estornar"];

/** Devolução record projection (null for Stripe-provenance payments). */
export type DevolucaoStatusResult = AdminOutputs["pagamentos"]["devolucaoStatus"];

/** Stripe refund reasons — threaded to refundarPagamento; Inter ignores it. */
export type EstornoReason = "duplicate" | "fraudulent" | "requested_by_customer";

/**
 * Trigger a refund. All money-safety rules (409 lançamento gate, status
 * guard, provenance routing, replay) live in the estornarPagamento
 * use-case server-side — this hook only fires the wrapper mutation and
 * invalidates every read that renders pagamento status.
 */
export function useEstornarPagamento() {
  const utils = trpc.useUtils();
  return trpc.admin.pagamentos.estornar.useMutation({
    onSuccess: () => {
      void utils.admin.pagamentos.listByContribuicao.invalidate();
      void utils.admin.pagamentos.listByCampanha.invalidate();
      void utils.admin.pagamentos.findById.invalidate();
      void utils.admin.pagamentos.devolucaoStatus.invalidate();
    },
  });
}

/**
 * Devolução status for an Inter-provenance payment. Polls every 3s while
 * the record is 'em_processamento' (the Inter webhook's verify-then-
 * finalize flips it); stops on terminal states and for Stripe payments
 * (null record). `enabled` gates the query entirely — the card only asks
 * once a refund exists to watch.
 */
export function useDevolucaoStatus(idPagamento: string, opts: { enabled?: boolean } = {}) {
  return trpc.admin.pagamentos.devolucaoStatus.useQuery(
    { idPagamento },
    {
      enabled: opts.enabled ?? true,
      refetchInterval: (query) => {
        const status = query.state.data?.devolucao?.status;
        if (status === "em_processamento") return 3000;
        return false;
      },
      staleTime: 2_000,
    },
  );
}
