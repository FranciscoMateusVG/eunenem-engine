import { useState } from "react";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import PagamentosList from "@/components/eunenem/admin/PagamentosList";

/**
 * PagamentosSection — FILLED ship (aperture-rsidz.5 W4 + aperture-pf348 webhook chip).
 *
 * Middle section of /admin/contribuicao/:idContribuicao. Renders the
 * Pagamentos-side facts of a single contribuicao: every pagamento attempt
 * (pendente / aprovado / rejeitado), each with its composição de valores
 * breakdown table + an operator-facing JsonViewer over the raw VO
 * snapshots (composicaoValores, transacaoExterna, intencao) + the webhook
 * event trail (aperture-pf348).
 *
 * File-swaps the W3 placeholder shipped on rsidz.4. Visual identity
 * (data-bc + DddBadge header) is preserved verbatim — no jump when the
 * placeholder gives way to the live data. The body delegates to
 * `<PagamentosList />` which calls `trpc.admin.pagamentos.listByContribuicao`.
 *
 * Aggregate webhook-failure chip:
 *   Each per-pagamento PagamentoWebhookList computes its own issue count
 *   (events where signatureValid=false OR processingError != null) and
 *   reports up through PagamentosList. We sum at this level and render an
 *   alert chip "⚠ N webhooks com erro" on the section header when total
 *   > 0. v1 is visual-only: clicking the chip doesn't navigate; operator
 *   expands the per-card subsection to find the offending events.
 *
 * Seam contract (W5 does not modify this file — only FinanceiroSection):
 *   - Default export `({ idContribuicao }) => JSX.Element`
 *   - Root element carries `data-bc="pagamentos"`
 *   - Renders the DddBadge header (amber) so BC wayfinding stays consistent
 */
export default function PagamentosSection({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  const [webhookIssueCount, setWebhookIssueCount] = useState(0);

  return (
    <section data-bc="pagamentos" className="space-y-3">
      <SectionHeader webhookIssueCount={webhookIssueCount} />
      <PagamentosList
        idContribuicao={idContribuicao}
        onWebhookIssueCountChange={setWebhookIssueCount}
      />
    </section>
  );
}

function SectionHeader({
  webhookIssueCount,
}: {
  webhookIssueCount: number;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-3">
        <DddBadge bc="pagamentos" size="sm" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          pagamentos
        </h2>
        {webhookIssueCount > 0 && (
          <WebhookFailureChip count={webhookIssueCount} />
        )}
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
        ciclo de cobrança · intenções + transações externas
      </span>
    </div>
  );
}

/**
 * Aggregate webhook-failure chip. Visible only when at least one event
 * across any pagamento has signature_valid=false OR processing_error.
 * v1 is signal-only (no click target) — operator manually expands a
 * pagamento's webhook subsection to find the failing event(s).
 */
function WebhookFailureChip({ count }: { count: number }) {
  return (
    <span
      role="status"
      aria-live="polite"
      title="Eventos webhook com falha de assinatura ou erro de processamento"
      className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.10em] text-red-800"
    >
      <span aria-hidden>⚠</span>
      {count} {count === 1 ? "webhook" : "webhooks"} com erro
    </span>
  );
}
