import { DddBadge } from "@/components/eunenem/admin/DddBadge";

/**
 * FinanceiroSection — PLACEHOLDER ship (aperture-rsidz.4, W3).
 *
 * Part of the locked W3 → W4 → W5 seam contract on /admin/contribuicao/:idContribuicao.
 * W3 ships this file as a pure placeholder shell so the operator sees the
 * Financeiro BC color identity (purple DddBadge) is already present —
 * no visual jump when W5 (aperture-rsidz.6) file-swaps the final
 * implementation in. The default-export signature is non-negotiable;
 * W5 reuses it verbatim.
 *
 * Contract (seam-locked):
 *   - Default export `({ idContribuicao }) => JSX.Element`
 *   - Root element carries `data-bc="financeiro"`
 *   - Renders the DddBadge header so BC wayfinding stays consistent
 *   - No internal state, no tRPC, no side effects — pure shell
 *
 * When W5 lands, this file is overwritten in full. Do NOT couple any
 * downstream code to its current shape — only to the section name +
 * default-export prop shape.
 */
export default function FinanceiroSection({
  idContribuicao: _idContribuicao,
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
          preenchida por W5 (aperture-rsidz.6)
        </span>
      </div>
      <div className="rounded-md border border-dashed border-line bg-paper px-5 py-12 text-center">
        <p className="font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
          Esta seção será preenchida por W5 (Financeiro).
        </p>
      </div>
    </section>
  );
}
