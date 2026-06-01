import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import ArrecadacaoSection from "@/components/eunenem/admin/sections/ArrecadacaoSection";
import FinanceiroSection from "@/components/eunenem/admin/sections/FinanceiroSection";
import PagamentosSection from "@/components/eunenem/admin/sections/PagamentosSection";

/**
 * /admin/contribuicao/:idContribuicao — contribuição detail page
 * (aperture-rsidz.4, W3).
 *
 * The aggregate/multi-BC view. AdminShell receives `activeBc={null}` so the
 * BcStrap renders the legend (the page touches THREE bounded contexts —
 * Arrecadação, Pagamentos, Financeiro — and no single one is "active"). Per-
 * section DddBadge headers carry the individual BC color identity instead.
 *
 * SEAM CONTRACT (rsidz.4 §1, non-negotiable for W4/W5):
 *   - The three section components below are file-swap surfaces. W4
 *     overwrites PagamentosSection.tsx; W5 overwrites FinanceiroSection.tsx.
 *     This page imports them by name and never touches the seam shape.
 *   - All three sections share `({ idContribuicao }: { idContribuicao: string }) => JSX.Element`.
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
        <FinanceiroSection idContribuicao={idContribuicao} />
      </section>
    </AdminShell>
  );
}
