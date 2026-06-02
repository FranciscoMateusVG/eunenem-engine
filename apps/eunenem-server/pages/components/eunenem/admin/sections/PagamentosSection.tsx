import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import PagamentosList from "@/components/eunenem/admin/PagamentosList";

/**
 * PagamentosSection — FILLED ship (aperture-rsidz.5, W4).
 *
 * Middle section of /admin/contribuicao/:idContribuicao. Renders the
 * Pagamentos-side facts of a single contribuicao: every pagamento attempt
 * (pendente / aprovado / rejeitado), each with its composição de valores
 * breakdown table + an operator-facing JsonViewer over the raw VO
 * snapshots (composicaoValores, transacaoExterna, intencao).
 *
 * File-swaps the W3 placeholder shipped on rsidz.4. Visual identity
 * (data-bc + DddBadge header) is preserved verbatim — no jump when the
 * placeholder gives way to the live data. The body delegates to
 * `<PagamentosList />` which calls `trpc.admin.pagamentos.listByContribuicao`.
 *
 * Seam contract (W5 does not modify this file — only FinanceiroSection):
 *   - Default export `({ idContribuicao }) =&gt; JSX.Element`
 *   - Root element carries `data-bc="pagamentos"`
 *   - Renders the DddBadge header (amber) so BC wayfinding stays consistent
 */
export default function PagamentosSection({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  return (
    <section data-bc="pagamentos" className="space-y-3">
      <SectionHeader />
      <PagamentosList idContribuicao={idContribuicao} />
    </section>
  );
}

function SectionHeader() {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-3">
        <DddBadge bc="pagamentos" size="sm" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          pagamentos
        </h2>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
        ciclo de cobrança · intenções + transações externas
      </span>
    </div>
  );
}
