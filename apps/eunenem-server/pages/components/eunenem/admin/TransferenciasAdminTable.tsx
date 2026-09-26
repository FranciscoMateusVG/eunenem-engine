import {
  ESTADO_EXTRATO_LABEL,
  ESTADO_EXTRATO_PILL_CLASS,
  type EstadoExtrato,
  formatDateTimeBR,
  shortId,
} from "@/components/eunenem/admin/financeiro-labels";
import { REPASSE_STATUS_LABEL } from "@/components/eunenem/admin/repasse-status";
import type { RepasseStatus } from "@/components/eunenem/admin/RepassesStubData";
import { formatBRL } from "@/lib/formatBRL";

/**
 * TransferenciasAdminTable — histórico de repasses das campanhas administradas
 * (aperture-5jk8y). Puro. `estadoExtrato` vem da projeção compartilhada com o
 * extrato do usuário (csye7): "Concluído" só quando o ledger tem carimbo.
 *
 * Sem destino bancário, sem telefone, sem botões — o detalhe fica em
 * /admin/repasses/:id.
 */

export interface TransferenciaAdminRow {
  idRepasse: string;
  idCampanha: string;
  campanhaTitulo: string;
  recebedorNome: string | null;
  amountCents: number;
  numLancamentos: number;
  status: RepasseStatus;
  solicitadoEm: string;
  enviadoAoBancoEm: string | null;
  bankTransferRef: string | null;
  transferReferencia: string | null;
  estadoExtrato: EstadoExtrato;
  concluidoEm: string | null;
  needsManualResolution: boolean;
}

export interface TransferenciasAdminTableProps {
  rows: readonly TransferenciaAdminRow[];
  totalCount: number;
  isLoading: boolean;
  isFetching: boolean;
  errorMessage: string | null;
  hasNext: boolean;
  onNext: () => void;
  hasPrev: boolean;
  onPrev: () => void;
  pageIndex: number;
}

export function TransferenciasAdminTable(p: TransferenciasAdminTableProps) {
  return (
    <div className="space-y-2">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
        histórico de transferências · repasses ({p.totalCount})
      </h3>

      {p.errorMessage !== null && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em]">erro ao carregar</p>
          <p className="mt-1">{p.errorMessage}</p>
        </div>
      )}

      {p.isLoading && p.errorMessage === null && (
        <div className="space-y-2" aria-busy="true">
          <div className="h-9 animate-pulse rounded bg-cream-2" />
          <div className="h-9 animate-pulse rounded bg-cream-2" />
        </div>
      )}

      {!p.isLoading && p.errorMessage === null && p.rows.length === 0 && (
        <p className="rounded-md border border-line bg-paper px-4 py-3 text-[13px] italic text-ink-mute">
          Nenhuma transferência.
        </p>
      )}

      {!p.isLoading && p.errorMessage === null && p.rows.length > 0 && (
        <div
          className={`overflow-x-auto rounded-md border border-line bg-paper ${p.isFetching ? "opacity-70" : ""}`}
        >
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-cream-2/40">
                <Th>solicitado em</Th>
                <Th>campanha</Th>
                <Th align="right">valor</Th>
                <Th align="right">lanç.</Th>
                <Th>estado</Th>
                <Th>concluído em</Th>
                <Th>referência</Th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r) => (
                <tr
                  key={r.idRepasse}
                  className="border-b border-line align-top transition-colors last:border-b-0 hover:bg-lilac-soft/30"
                >
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] tabular-nums text-ink-soft">
                    <a href={`/admin/repasses/${r.idRepasse}`} className="hover:text-plum">
                      {formatDateTimeBR(r.solicitadoEm)}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={`/admin/campanha/${r.idCampanha}`}
                      className="text-[13px] text-ink hover:text-plum"
                    >
                      {r.campanhaTitulo}
                    </a>
                    {r.recebedorNome && (
                      <p className="text-[11px] text-ink-mute">{r.recebedorNome}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink">
                    {formatBRL(r.amountCents)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] tabular-nums text-ink-soft">
                    {r.numLancamentos}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${ESTADO_EXTRATO_PILL_CLASS[r.estadoExtrato]}`}
                    >
                      {ESTADO_EXTRATO_LABEL[r.estadoExtrato]}
                    </span>
                    <p className="mt-1 text-[11px] text-ink-mute">
                      status {REPASSE_STATUS_LABEL[r.status] ?? r.status}
                      {r.needsManualResolution ? " · resolução manual" : ""}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] tabular-nums text-ink-soft">
                    {r.concluidoEm ? formatDateTimeBR(r.concluidoEm) : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-ink-mute">
                    {r.transferReferencia ?? r.bankTransferRef ?? shortId(r.idRepasse)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(p.hasPrev || p.hasNext) && (
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={p.onPrev}
            disabled={!p.hasPrev || p.isFetching}
            className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft hover:text-plum disabled:cursor-not-allowed disabled:opacity-40"
          >
            ← anterior
          </button>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
            página {p.pageIndex + 1}
          </span>
          <button
            type="button"
            onClick={p.onNext}
            disabled={!p.hasNext || p.isFetching}
            className="rounded-md border border-line bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink-soft hover:text-plum disabled:cursor-not-allowed disabled:opacity-40"
          >
            próxima →
          </button>
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
