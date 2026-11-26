import type { inferRouterOutputs } from "@trpc/server";
import { bucketsDoPeriodoCaixa, type CaixaGranularidade } from "@/lib/caixaPeriodo";
import { formatBRL } from "@/lib/formatBRL";
import { formatLocalDate, isLocalDate, localDateInSaoPaulo } from "@/lib/receitaPeriodo";
import type { AppRouter } from "../../../../server/trpc/router.js";
import { REPASSE_STATUS_LABEL } from "./repasse-status";
import type { RepasseStatus } from "./RepassesStubData";

/**
 * Resgates aceitos pelo banco num período (aperture-9nmdo). A MESMA tabela
 * aparece nas saídas do Fluxo de caixa e no filtro de período da tela de
 * resgates (/admin/repasses), alimentada pela mesma consulta do servidor
 * (`listarResgatesEfetuados`): os dois totais são iguais por construção.
 * Datas no horário de São Paulo.
 */

export type ResgateEfetuadoData =
  inferRouterOutputs<AppRouter>["admin"]["repasses"]["efetuados"]["resgates"][number];

export interface PeriodoResgates {
  /** Data local SP, inclusiva. */
  readonly de: string;
  /** Data local SP, exclusiva (mesma convenção do Fluxo de caixa). */
  readonly ate: string;
}

/** `?de=&ate=` da tela de resgates; período inválido ou incompleto = sem filtro. */
export function periodoResgatesDaUrl(search: string): PeriodoResgates | null {
  const params = new URLSearchParams(search);
  const de = params.get("de");
  const ate = params.get("ate");
  if (!de || !ate || !isLocalDate(de) || !isLocalDate(ate) || de >= ate) return null;
  return { de, ate };
}

/** A granularidade mais fina que o Fluxo de caixa aceita para o período (≤ 400 buckets). */
export function granularidadeParaCaixa(periodo: PeriodoResgates): CaixaGranularidade {
  for (const g of ["dia", "semana"] as const) {
    if (bucketsDoPeriodoCaixa({ ...periodo, granularidade: g }).ok) return g;
  }
  return "mes";
}

const TH =
  "px-3 py-2 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mute";
const TD = "px-3 py-2 text-ink-soft";

function rotuloStatus(status: string): string {
  return REPASSE_STATUS_LABEL[status as RepasseStatus] ?? status;
}

export function ResgatesEfetuadosTabela({
  resgates,
  totalCents,
}: {
  resgates: readonly ResgateEfetuadoData[];
  totalCents: number;
}) {
  if (resgates.length === 0) {
    return (
      <p className="text-[13px] text-ink-mute" data-testid="resgates-efetuados-vazio">
        Nenhum resgate aceito pelo banco neste período.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-ink" data-testid="resgates-efetuados-total">
        {resgates.length} resgate(s) · total{" "}
        <span className="font-mono font-semibold tabular-nums">{formatBRL(totalCents)}</span>
      </p>
      <div className="overflow-x-auto rounded-md border border-line bg-white">
      <table className="w-full text-[13px]" data-testid="resgates-efetuados">
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={TH}>
              Aceito em
            </th>
            <th scope="col" className={TH}>
              Campanha
            </th>
            <th scope="col" className={TH}>
              Recebedor
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            <th scope="col" className={TH}>
              Forma
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Valor
            </th>
          </tr>
        </thead>
        <tbody>
          {resgates.map((r) => (
            <tr key={r.idRepasse} className="border-b border-line last:border-0">
              <td className={`${TD} whitespace-nowrap font-mono tabular-nums`}>
                {formatLocalDate(localDateInSaoPaulo(new Date(r.efetuadoEm)))}
              </td>
              <td className={TD}>
                <a href={`/admin/repasses/${r.idRepasse}`} className="text-ink hover:text-plum">
                  {r.campanhaTitulo}
                </a>
              </td>
              <td className={TD}>
                {r.recebedorNome ?? <span className="italic text-ink-mute">(sem recebedor)</span>}
              </td>
              <td className={TD}>{rotuloStatus(r.status)}</td>
              <td className={TD}>
                {r.metodo === "inter"
                  ? "Inter"
                  : `Manual${r.bankTransferRef ? ` · ${r.bankTransferRef}` : ""}`}
              </td>
              <td className={`${TD} whitespace-nowrap text-right font-mono tabular-nums text-ink`}>
                {formatBRL(r.amountCents)}
              </td>
            </tr>
          ))}
          <tr className="bg-surface-soft">
            <th scope="row" colSpan={5} className="px-3 py-2 text-left font-semibold text-ink">
              Total dos resgates
            </th>
            <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-semibold tabular-nums text-ink">
              {formatBRL(totalCents)}
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  );
}
