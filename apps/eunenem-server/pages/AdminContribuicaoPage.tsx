import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import ArrecadacaoSection from "@/components/eunenem/admin/sections/ArrecadacaoSection";
import PagamentosSection from "@/components/eunenem/admin/sections/PagamentosSection";

/**
 * /admin/contribuicao/:idContribuicao — contribuição detail page
 * (plan 0015 BC reshape, aperture-c5vq2).
 *
 * The aggregate/multi-BC view. AdminShell receives `activeBc={null}` so the
 * BcStrap renders the legend (the page touches THREE bounded contexts —
 * Arrecadação, Pagamentos, Financeiro — and no single one is "active"). Per-
 * section DddBadge headers carry the individual BC color identity instead.
 * Financeiro's purple identity now appears as the sub-header strip inside
 * each PagamentoCard's <LancamentosBlock />, NOT as a sibling section,
 * because per plan 0015 Locked Decision #1 Financeiro is a MODULE inside
 * Pagamentos rather than its own BC.
 *
 * SECTION COMPOSITION:
 *   - ArrecadacaoSection  — emerald BC header, the contribuição slot itself
 *   - PagamentosSection   — amber BC header, every pagamento attempt PLUS
 *                           its nested financeiro ledger + webhook trail
 *
 * Breadcrumb chooses "admin / contribuição / <short id>" — we don't have
 * the campanha id at routing time (only the contribuicao id is in the
 * URL), so the campanha link lives inside ArrecadacaoSection's
 * CampanhaBlock once the multi-aggregate payload resolves.
 */
export function AdminContribuicaoPage({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  const shortId = `${idContribuicao.slice(0, 8)}…`;
  return (
    <AdminShell
      activeBc={null}
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "contribuição" },
        { label: shortId },
      ]}
      bcContext={
        <>
          contribuição <span className="text-ink">{shortId}</span>
        </>
      }
    >
      <section className="space-y-10">
        <ArrecadacaoSection idContribuicao={idContribuicao} />
        <PagamentosSection idContribuicao={idContribuicao} />
      </section>
    </AdminShell>
  );
}
