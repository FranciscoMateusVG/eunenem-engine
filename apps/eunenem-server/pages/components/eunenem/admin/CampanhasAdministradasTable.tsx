import { shortId } from "@/components/eunenem/admin/financeiro-labels";
import type { TotaisResumo } from "@/components/eunenem/admin/ResumoFinanceiroCard";
import { formatBRL } from "@/lib/formatBRL";

/**
 * CampanhasAdministradasTable — uma linha por campanha administrada pela conta
 * (aperture-5jk8y). Puro.
 *
 * - Rótulo honesto: são campanhas ADMINISTRADAS (papel), não patrimônio.
 * - "compartilhada com" lista os coadmins (os outros administradores).
 * - Celular = titular do recebimento (recebedor ativo), MASCARADO pelo servidor;
 *   este componente nunca recebe o número completo.
 * - Lista pode estar truncada (>100); os totais do card acima cobrem todas.
 */

export interface CampanhaAdministradaRow {
  idCampanha: string;
  titulo: string;
  administradores: Array<{ idConta: string; nomeExibicao: string | null; email: string | null }>;
  celularTitularMascarado: string | null;
  totais: TotaisResumo;
}

export interface CampanhasAdministradasTableProps {
  idConta: string;
  campanhas: readonly CampanhaAdministradaRow[];
  campanhasTotal: number;
  truncated: boolean;
}

export function CampanhasAdministradasTable({
  idConta,
  campanhas,
  campanhasTotal,
  truncated,
}: CampanhasAdministradasTableProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          campanhas administradas por esta conta ({campanhasTotal})
        </h3>
        {truncated && (
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber-900">
            mostrando {campanhas.length} de {campanhasTotal} · totais acima cobrem todas
          </span>
        )}
      </div>

      {campanhas.length === 0 ? (
        <p className="rounded-md border border-line bg-paper px-4 py-3 text-[13px] italic text-ink-mute">
          Sem campanhas administradas.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-paper">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-cream-2/40">
                <Th>campanha</Th>
                <Th>compartilhada com</Th>
                <Th align="right">recebido</Th>
                <Th align="right">resgatado</Th>
                <Th align="right">disponível</Th>
                <Th align="right">pend. conferência</Th>
                <Th align="right">estornado</Th>
                <Th>celular do titular</Th>
              </tr>
            </thead>
            <tbody>
              {campanhas.map((c) => {
                const coadmins = c.administradores.filter((a) => a.idConta !== idConta);
                return (
                  <tr
                    key={c.idCampanha}
                    className="border-b border-line transition-colors last:border-b-0 hover:bg-lilac-soft/30"
                  >
                    <td className="px-4 py-3">
                      <a
                        href={`/admin/campanha/${c.idCampanha}`}
                        className="text-[13px] text-ink hover:text-plum"
                      >
                        {c.titulo}
                      </a>
                    </td>
                    <td className="px-4 py-3 text-[12px] text-ink-soft">
                      {coadmins.length === 0 ? (
                        <span className="italic text-ink-mute">somente esta conta</span>
                      ) : (
                        coadmins.map((a) => a.nomeExibicao ?? a.email ?? shortId(a.idConta)).join(", ")
                      )}
                    </td>
                    <Money cents={c.totais.recebidoConfirmadoCents} strong />
                    <Money cents={c.totais.resgatadoConcluidoCents} />
                    <Money cents={c.totais.disponivelCents} />
                    <Money
                      cents={c.totais.pendenteConferenciaCents}
                      tone={c.totais.pendenteConferenciaCents > 0 ? "warn" : "default"}
                    />
                    <Money cents={c.totais.estornadoCents} tone="muted" />
                    <td className="px-4 py-3 font-mono text-[12px] tabular-nums text-ink-soft">
                      {c.celularTitularMascarado ?? (
                        <span className="italic text-ink-mute">não informado</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={[
        "px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute",
        align === "right" ? "text-right" : "text-left",
      ].join(" ")}
    >
      {children}
    </th>
  );
}

function Money({
  cents,
  strong = false,
  tone = "default",
}: {
  cents: number;
  strong?: boolean;
  tone?: "default" | "muted" | "warn";
}) {
  const color =
    tone === "muted" ? "text-ink-mute" : tone === "warn" ? "text-amber-900" : "text-ink";
  return (
    <td
      className={`px-4 py-3 text-right font-mono text-[13px] tabular-nums ${color} ${strong ? "font-semibold" : ""}`}
    >
      {formatBRL(cents)}
    </td>
  );
}
