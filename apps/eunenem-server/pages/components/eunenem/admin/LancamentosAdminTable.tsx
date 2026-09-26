import {
  type BucketAdmin,
  BUCKET_GLOSS,
  BUCKET_LABEL,
  BUCKET_ORDER,
  BUCKET_PILL_CLASS,
  formatDateBR,
  formatDateTimeBR,
  METODO_LABEL,
  MOTIVO_LABEL,
  shortId,
} from "@/components/eunenem/admin/financeiro-labels";
import { REPASSE_STATUS_LABEL } from "@/components/eunenem/admin/repasse-status";
import type { RepasseStatus } from "@/components/eunenem/admin/RepassesStubData";
import { formatBRL } from "@/lib/formatBRL";

/**
 * LancamentosAdminTable — lançamentos de crédito ao recebedor, um por linha
 * do ledger, com o bucket do classificador único (aperture-5jk8y). Puro:
 * estado de filtro/paginação vive na página e chega por props.
 *
 * Sem botões de ação. Nenhuma coluna de telefone. Empty/loading/error honestos.
 */

export interface LancamentoAdminRow {
  idLancamento: string;
  criadoEm: string;
  pagamentoCriadoEm: string | null;
  idCampanha: string;
  campanhaTitulo: string;
  idContribuicao: string;
  contribuicaoNome: string | null;
  idPagamento: string;
  metodo: "pix" | "credit_card" | null;
  amountCents: number;
  bucket: BucketAdmin;
  motivo: string | null;
  elegivelRecebido: boolean;
  liberacaoPrevistaEm: string | null;
  idRepasse: string | null;
  repasseStatus: string | null;
  transferidoEm: string | null;
  canceladoEm: string | null;
}

export interface LancamentosAdminTableProps {
  rows: readonly LancamentoAdminRow[];
  totalCount: number;
  isLoading: boolean;
  isFetching: boolean;
  errorMessage: string | null;
  estado: BucketAdmin | null;
  onEstadoChange: (estado: BucketAdmin | null) => void;
  idCampanha: string | null;
  onCampanhaChange: (idCampanha: string | null) => void;
  campanhas: ReadonlyArray<{ idCampanha: string; titulo: string }>;
  hasNext: boolean;
  onNext: () => void;
  hasPrev: boolean;
  onPrev: () => void;
  pageIndex: number;
  filterIdPrefix: string;
}

export function LancamentosAdminTable(p: LancamentosAdminTableProps) {
  const estadoId = `${p.filterIdPrefix}-estado`;
  const campanhaId = `${p.filterIdPrefix}-campanha`;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          contribuições recebidas · lançamentos ({p.totalCount})
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor={estadoId} className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
              estado
            </span>
            <select
              id={estadoId}
              value={p.estado ?? ""}
              onChange={(e) => p.onEstadoChange((e.target.value || null) as BucketAdmin | null)}
              className="rounded-md border border-line bg-paper px-2 py-1.5 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-plum/40"
            >
              <option value="">todos</option>
              {BUCKET_ORDER.map((b) => (
                <option key={b} value={b}>
                  {BUCKET_LABEL[b]}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={campanhaId} className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
              campanha
            </span>
            <select
              id={campanhaId}
              value={p.idCampanha ?? ""}
              onChange={(e) => p.onCampanhaChange(e.target.value || null)}
              className="max-w-[16rem] rounded-md border border-line bg-paper px-2 py-1.5 text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-plum/40"
            >
              <option value="">todas</option>
              {p.campanhas.map((c) => (
                <option key={c.idCampanha} value={c.idCampanha}>
                  {c.titulo}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

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
          <div className="h-9 animate-pulse rounded bg-cream-2" />
        </div>
      )}

      {!p.isLoading && p.errorMessage === null && p.rows.length === 0 && (
        <p className="rounded-md border border-line bg-paper px-4 py-3 text-[13px] italic text-ink-mute">
          {p.estado !== null || p.idCampanha !== null
            ? "Nenhum lançamento neste filtro."
            : "Nenhum lançamento."}
        </p>
      )}

      {!p.isLoading && p.errorMessage === null && p.rows.length > 0 && (
        <div
          className={`overflow-x-auto rounded-md border border-line bg-paper ${p.isFetching ? "opacity-70" : ""}`}
        >
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-cream-2/40">
                <Th>data</Th>
                <Th>campanha</Th>
                <Th>contribuição</Th>
                <Th>pagamento</Th>
                <Th align="right">líquido</Th>
                <Th>estado</Th>
                <Th>repasse</Th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r) => (
                <LancamentoRow key={r.idLancamento} r={r} />
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

function LancamentoRow({ r }: { r: LancamentoAdminRow }) {
  const motivo = r.motivo ? (MOTIVO_LABEL[r.motivo] ?? r.motivo) : null;
  const repasseLabel =
    r.repasseStatus && r.repasseStatus in REPASSE_STATUS_LABEL
      ? REPASSE_STATUS_LABEL[r.repasseStatus as RepasseStatus]
      : r.repasseStatus;
  return (
    <tr className="border-b border-line align-top transition-colors last:border-b-0 hover:bg-lilac-soft/30">
      <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] tabular-nums text-ink-soft">
        {formatDateTimeBR(r.pagamentoCriadoEm ?? r.criadoEm)}
      </td>
      <td className="px-4 py-3">
        <a href={`/admin/campanha/${r.idCampanha}`} className="text-[13px] text-ink hover:text-plum">
          {r.campanhaTitulo}
        </a>
      </td>
      <td className="px-4 py-3 text-[13px] text-ink">
        {r.contribuicaoNome ?? <span className="italic text-ink-mute">(contribuição removida)</span>}
      </td>
      <td className="px-4 py-3">
        <a
          href={`/admin/pagamento/${r.idPagamento}`}
          className="font-mono text-[12px] text-ink-soft hover:text-plum"
        >
          {r.metodo ? METODO_LABEL[r.metodo] : "—"} · {shortId(r.idPagamento)}
        </a>
      </td>
      <td
        className={`px-4 py-3 text-right font-mono text-[13px] tabular-nums ${
          r.elegivelRecebido ? "text-ink" : "text-ink-mute line-through decoration-ink-mute/60"
        }`}
      >
        {formatBRL(r.amountCents)}
      </td>
      <td className="px-4 py-3">
        <BucketPill bucket={r.bucket} />
        {r.bucket === "aguardando_liberacao" && r.liberacaoPrevistaEm && (
          <p className="mt-1 text-[11px] text-ink-soft">
            previsto para {formatDateBR(r.liberacaoPrevistaEm)}
          </p>
        )}
        {r.bucket === "aguardando_liberacao" && !r.liberacaoPrevistaEm && (
          <p className="mt-1 text-[11px] text-ink-mute">data de liberação desconhecida</p>
        )}
        {r.bucket === "estorno_em_andamento" && (
          <p className="mt-1 text-[11px] text-amber-900">valor ainda não estornado</p>
        )}
        {r.bucket === "estornado" && r.canceladoEm && (
          <p className="mt-1 text-[11px] text-ink-mute">em {formatDateBR(r.canceladoEm)}</p>
        )}
        {r.bucket === "transferido" && r.transferidoEm && (
          <p className="mt-1 text-[11px] text-ink-soft">em {formatDateBR(r.transferidoEm)}</p>
        )}
        {motivo && <p className="mt-1 text-[11px] text-amber-900">{motivo}</p>}
      </td>
      <td className="px-4 py-3">
        {r.idRepasse ? (
          <a
            href={`/admin/repasses/${r.idRepasse}`}
            className="font-mono text-[12px] text-ink-soft hover:text-plum"
          >
            {shortId(r.idRepasse)}
            {repasseLabel ? ` · ${repasseLabel}` : ""}
          </a>
        ) : (
          <span className="font-mono text-[12px] text-ink-mute">—</span>
        )}
      </td>
    </tr>
  );
}

export function BucketPill({ bucket }: { bucket: BucketAdmin }) {
  return (
    <span
      title={BUCKET_GLOSS[bucket]}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${BUCKET_PILL_CLASS[bucket]}`}
    >
      {BUCKET_LABEL[bucket]}
    </span>
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
