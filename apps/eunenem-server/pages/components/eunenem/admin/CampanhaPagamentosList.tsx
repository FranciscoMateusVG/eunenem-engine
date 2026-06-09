import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc.js";

/**
 * CampanhaPagamentosList — Plan 0017 / aperture-gf2t5.
 *
 * The PRIMARY section body on /admin/campanha/:id. Lists every pagamento
 * across the campanha (all contribuições, deduped), with at-a-glance status
 * + total + contribuinte + criado em + item count. Click a row to drill into
 * /admin/pagamento/:id.
 *
 * Filters (client-side, since the list is bounded small in practice):
 *   - Status chip strip — "Todos" + each FSM state present in the result set
 *   - Método chip strip — "Todos" + pix + cartão (when present)
 *
 * Sort is fixed: criadoEm DESC (most recent first), matching the wire's
 * server-side sort.
 *
 * Empty/error states: dedicated affordances. The empty-state copy hints
 * that the campanha hasn't received any pagamentos yet (vs the "loading"
 * spinner).
 */
type PagamentoRow = {
  id: string;
  status: "pendente" | "processing" | "aprovado" | "rejeitado" | "estornado";
  metodo: "pix" | "credit_card";
  criadoEm: string;
  totalPaidCents: number;
  itemCount: number;
  contribuinteNome: string | null;
  liberacao: "aguardando_liberacao" | "disponivel" | null;
};

export function CampanhaPagamentosList({ idCampanha }: { idCampanha: string }) {
  const { data, isLoading, error } =
    trpc.admin.pagamentos.listByCampanha.useQuery({ idCampanha });

  const rows = useMemo<PagamentoRow[]>(() => {
    if (!data) return [];
    return data.pagamentos.map((p) => ({
      id: p.id,
      status: p.status,
      metodo: p.intencao.metodo,
      criadoEm: p.criadoEm,
      totalPaidCents: p.intencao.composicaoValoresAggregate.totalPaidCents,
      itemCount: p.intencao.items.filter((i) => i.tipo === "contribuicao")
        .length,
      contribuinteNome: p.intencao.contribuinte?.nome ?? null,
      liberacao: p.liberacao,
    }));
  }, [data]);

  const statusOptions = useMemo(() => {
    const present = new Set(rows.map((r) => r.status));
    const order: PagamentoRow["status"][] = [
      "aprovado",
      "pendente",
      "processing",
      "rejeitado",
      "estornado",
    ];
    return order.filter((s) => present.has(s));
  }, [rows]);

  const metodoOptions = useMemo(() => {
    const present = new Set(rows.map((r) => r.metodo));
    return (["pix", "credit_card"] as PagamentoRow["metodo"][]).filter((m) =>
      present.has(m),
    );
  }, [rows]);

  const [statusFilter, setStatusFilter] = useState<PagamentoRow["status"] | "all">(
    "all",
  );
  const [metodoFilter, setMetodoFilter] = useState<
    PagamentoRow["metodo"] | "all"
  >("all");

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (metodoFilter !== "all" && r.metodo !== metodoFilter) return false;
      return true;
    });
  }, [rows, statusFilter, metodoFilter]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <div className="h-12 animate-pulse rounded-md bg-cream-2" />
        <div className="h-12 animate-pulse rounded-md bg-cream-2" />
        <div className="h-12 animate-pulse rounded-md bg-cream-2" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em]">erro</p>
        <p className="mt-1">{error.message}</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-line bg-paper px-5 py-8 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
          nenhum pagamento ainda
        </p>
        <p className="mt-2 text-[13px] text-ink-soft">
          Quando alguém comprar um presente nesta campanha, o pagamento
          aparecerá aqui.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
        <FilterStrip
          label="status"
          options={[
            { value: "all", label: `todos (${rows.length})` },
            ...statusOptions.map((s) => ({
              value: s,
              label: `${STATUS_LABEL[s]} (${rows.filter((r) => r.status === s).length})`,
            })),
          ]}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as PagamentoRow["status"] | "all")}
        />
        {metodoOptions.length > 1 && (
          <FilterStrip
            label="método"
            options={[
              { value: "all", label: "todos" },
              ...metodoOptions.map((m) => ({
                value: m,
                label: METODO_LABEL[m],
              })),
            ]}
            value={metodoFilter}
            onChange={(v) =>
              setMetodoFilter(v as PagamentoRow["metodo"] | "all")
            }
          />
        )}
      </div>

      {/* Counter */}
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
        {filtered.length} de {rows.length} pagamento{rows.length === 1 ? "" : "s"}
      </p>

      {/* Rows */}
      <ul className="divide-y divide-line overflow-hidden rounded-md border border-line bg-paper">
        {filtered.length === 0 && (
          <li className="px-4 py-5 text-center text-[12px] text-ink-mute">
            Nenhum pagamento com esses filtros.
          </li>
        )}
        {filtered.map((row) => (
          <li key={row.id}>
            <a
              href={`/admin/pagamento/${row.id}`}
              className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-cream-2/40 focus:bg-cream-2/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-plum sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="flex items-center gap-3 sm:min-w-[230px]">
                <StatusChip status={row.status} liberacao={row.liberacao} />
                <span className="font-mono text-[11px] uppercase tracking-[0.10em] text-ink-mute">
                  {METODO_LABEL[row.metodo]}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-0.5">
                <span className="text-[14px] font-medium text-ink">
                  {row.contribuinteNome ?? (
                    <span className="italic text-ink-soft">
                      (sem contribuinte)
                    </span>
                  )}
                </span>
                <span className="font-mono text-[11px] text-ink-mute">
                  {fmtIso(row.criadoEm)} ·{" "}
                  {row.itemCount === 1
                    ? "1 item"
                    : `${row.itemCount} itens`}{" "}
                  · id {row.id.slice(0, 8)}…
                </span>
              </div>
              <div className="flex items-center gap-2 sm:justify-end sm:text-right">
                <span className="font-mono text-[14px] tabular-nums text-ink">
                  {fmtBRL(row.totalPaidCents)}
                </span>
                <span aria-hidden className="text-ink-mute">
                  ›
                </span>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<PagamentoRow["status"], string> = {
  pendente: "pendente",
  processing: "processando",
  aprovado: "aprovado",
  rejeitado: "rejeitado",
  estornado: "estornado",
};

const METODO_LABEL: Record<PagamentoRow["metodo"], string> = {
  pix: "pix",
  credit_card: "cartão",
};

type ChipPalette = {
  border: string;
  bg: string;
  text: string;
  dot: string;
};

// Mirrors STATUS_PALETTE in PagamentosList.tsx so the row chips and the
// detail card chips speak the same visual vocabulary. Kept independent
// (rather than imported) so this list component has no cross-file coupling
// to the detail card's internals.
const STATUS_CHIP: Record<PagamentoRow["status"], ChipPalette> = {
  pendente: {
    border: "border-line",
    bg: "bg-cream-2",
    text: "text-ink-soft",
    dot: "bg-ink-mute",
  },
  processing: {
    border: "border-amber-200",
    bg: "bg-amber-50",
    text: "text-amber-800",
    dot: "bg-amber-500",
  },
  aprovado: {
    border: "border-emerald-200",
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    dot: "bg-emerald-500",
  },
  rejeitado: {
    border: "border-red-200",
    bg: "bg-red-50",
    text: "text-red-800",
    dot: "bg-red-500",
  },
  estornado: {
    border: "border-stone-300",
    bg: "bg-stone-100",
    text: "text-stone-700",
    dot: "bg-stone-500",
  },
};

const LIBERACAO_CHIP: Record<
  "aguardando_liberacao" | "disponivel",
  ChipPalette & { label: string }
> = {
  aguardando_liberacao: {
    border: "border-amber-300",
    bg: "bg-amber-100",
    text: "text-amber-700",
    dot: "bg-amber-600",
    label: "aguardando liberação",
  },
  disponivel: {
    border: "border-emerald-200",
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    dot: "bg-emerald-500",
    label: "disponível",
  },
};

function StatusChip({
  status,
  liberacao,
}: {
  status: PagamentoRow["status"];
  liberacao: PagamentoRow["liberacao"];
}) {
  // When the pagamento is aprovado, the liberação overlay is the more
  // operator-relevant signal (it tells them whether the money can be
  // transferred). Use it if available, else fall back to the status chip.
  if (status === "aprovado" && liberacao) {
    const p = LIBERACAO_CHIP[liberacao];
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border ${p.border} ${p.bg} px-2.5 py-[3px] font-mono text-[10px] uppercase tracking-[0.10em] ${p.text}`}
      >
        <span aria-hidden className={`size-[6px] rounded-full ${p.dot}`} />
        {p.label}
      </span>
    );
  }
  const p = STATUS_CHIP[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border ${p.border} ${p.bg} px-2.5 py-[3px] font-mono text-[10px] uppercase tracking-[0.10em] ${p.text}`}
    >
      <span aria-hidden className={`size-[6px] rounded-full ${p.dot}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

function FilterStrip({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const isActive = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`rounded-full border px-2.5 py-[3px] font-mono text-[10px] uppercase tracking-[0.10em] transition-colors ${
                isActive
                  ? "border-plum bg-plum/10 text-plum"
                  : "border-line bg-paper text-ink-soft hover:border-ink-mute"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function fmtBRL(cents: number): string {
  const reais = cents / 100;
  return reais.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function fmtIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}
