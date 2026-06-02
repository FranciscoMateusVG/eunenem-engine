import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { LancamentosList } from "@/components/eunenem/admin/LancamentosList";

/**
 * FinanceiroSection — FILLED ship (aperture-rsidz.6, W5).
 *
 * Bottom section of /admin/contribuicao/:idContribuicao. Renders the
 * Financeiro BC's lancamento ledger for the contribuicao: one block per
 * pagamento, double-entry row pair (saldo do recebedor + receita da
 * plataforma) for aprovado pagamentos, explicit "sem lançamentos"
 * affordance for pendente/rejeitado.
 *
 * This is the LEAF of the DDD-trace drill-down (Arrecadação → Pagamentos
 * → Financeiro) — the operator-visible payoff of the BC discipline. The
 * double-entry visualization is intentional: every aprovado pagamento
 * books two ledger entries, and the UI makes that booking discipline
 * legible at a glance.
 *
 * File-swaps the W3 placeholder ship (aperture-rsidz.4). Seam contract is
 * preserved verbatim:
 *   - Default export `({ idContribuicao }) => JSX.Element`
 *   - Root element carries `data-bc="financeiro"`
 *   - DddBadge header (purple/Financeiro) stays for BC wayfinding
 *
 * Data layer: trpc.admin.financeiro.listByContribuicao composes server-side
 * across Pagamentos → Financeiro (LivroFinanceiroRepositoryPostgres,
 * aperture-id3ay). See LancamentosList for the rendering details and the
 * status-lifecycle affordances.
 */
export default function FinanceiroSection({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  return (
    <section data-bc="financeiro" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-3">
          <DddBadge bc="financeiro" size="sm" />
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
            financeiro
          </h2>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          livro · lançamentos por pagamento
        </span>
      </div>
      <LancamentosList idContribuicao={idContribuicao} />
    </section>
  );
}
