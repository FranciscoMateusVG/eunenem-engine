import { useMemo, useState } from "react";
import { AdminShell } from "@/components/eunenem/admin/AdminShell";
import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import {
  type RepasseListRow,
  type RepasseStatus,
  useStubRepassesList,
} from "@/components/eunenem/admin/RepassesStubData";

/**
 * /admin/repasses — operator-facing repasses approval queue (plan q2d4b
 * Track 3, aperture-vi0hy parallel-prep against aperture-riywh).
 *
 * Operators see the queue of pending recebedor repasses ("solicitado"
 * filter is the default — the action queue), approve each via the detail
 * page, optionally record a bankTransferRef. Approved repasses move to
 * the "aprovado" filter (historical record).
 *
 * VISUAL IDENTITY: financeiro DddBadge purple. Repasses is the
 * operator-facing surface of the Financeiro module; it's not its own BC,
 * but Financeiro's purple wayfinding is the right semantic anchor
 * (operator sees this as "managing money flows out of the platform").
 *
 * LAYOUT:
 *   AdminShell with activeNav="repasses" so the sidebar highlights the
 *   new entry. Body sections:
 *     - HEADER (financeiro DddBadge + h2 "repasses" + small-caps subtitle)
 *     - FilterChips (solicitado / aprovado — defaults to solicitado)
 *     - List <table> with columns: campanha, recebedor, valor, lançamentos,
 *       solicitado em. Rows are clickable links to /admin/repasses/:idRepasse
 *
 * EMPTY STATE: when the filtered list is empty, render an honest
 * "(sem repasses neste filtro)" affordance — operator knows immediately
 * if the queue is empty vs the page failing to load.
 *
 * DATA LAYER: `useStubRepassesList()` returns the full set; this page
 * filters by status client-side. Same shape as the eventual trpc query.
 * See RepassesStubData.ts for the swap playbook when Rex's PR lands.
 */
export function AdminRepassesPage() {
  const [statusFilter, setStatusFilter] =
    useState<RepasseStatus>("solicitado");
  const { rows, isLoading, error } = useStubRepassesList();

  const filtered = useMemo(
    () => rows.filter((r) => r.status === statusFilter),
    [rows, statusFilter],
  );
  const counts = useMemo(
    () => ({
      solicitado: rows.filter((r) => r.status === "solicitado").length,
      aprovado: rows.filter((r) => r.status === "aprovado").length,
    }),
    [rows],
  );

  return (
    <AdminShell
      activeNav="repasses"
      breadcrumb={[
        { label: "admin", href: "/admin" },
        { label: "repasses" },
      ]}
      bcContext={<>fila de aprovação · financeiro</>}
    >
      <section className="space-y-6">
        <SectionHeader />
        <FilterChips
          active={statusFilter}
          onChange={setStatusFilter}
          counts={counts}
        />
        {isLoading && <LoadingState />}
        {error && <ErrorState message={error.message} />}
        {!isLoading && !error && filtered.length === 0 && (
          <EmptyState statusFilter={statusFilter} />
        )}
        {!isLoading && !error && filtered.length > 0 && (
          <RepassesTable rows={filtered} />
        )}
      </section>
    </AdminShell>
  );
}

function SectionHeader() {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-3">
        <DddBadge bc="financeiro" size="sm" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          repasses
        </h2>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
        aprovar saídas para o recebedor
      </span>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Filter chips
 * --------------------------------------------------------------------- */

function FilterChips({
  active,
  onChange,
  counts,
}: {
  active: RepasseStatus;
  onChange: (status: RepasseStatus) => void;
  counts: { solicitado: number; aprovado: number };
}) {
  const filters: ReadonlyArray<{
    key: RepasseStatus;
    label: string;
    count: number;
  }> = [
    { key: "solicitado", label: "solicitado", count: counts.solicitado },
    { key: "aprovado", label: "aprovado", count: counts.aprovado },
  ];
  return (
    <div
      role="tablist"
      aria-label="Filtrar repasses por status"
      className="flex flex-wrap items-center gap-2"
    >
      {filters.map((f) => (
        <FilterChip
          key={f.key}
          status={f.key}
          label={f.label}
          count={f.count}
          active={active === f.key}
          onClick={() => onChange(f.key)}
        />
      ))}
    </div>
  );
}

function FilterChip({
  status,
  label,
  count,
  active,
  onClick,
}: {
  status: RepasseStatus;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const palette = STATUS_PALETTE[status];
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        "inline-flex items-center gap-2 rounded-full border px-3 py-[5px] font-mono text-[11px] uppercase tracking-[0.12em] transition-opacity",
        palette.border,
        palette.bg,
        palette.text,
        active
          ? "ring-1 ring-ink/30 ring-offset-1 ring-offset-paper"
          : "opacity-60 hover:opacity-100 focus:opacity-100",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={`inline-block size-[6px] rounded-full ${palette.dot}`}
      />
      <span>{label}</span>
      <span className="tabular-nums opacity-80">({count})</span>
    </button>
  );
}

/* -----------------------------------------------------------------------
 * Status palette — local to this surface; mirrors PagamentosList palette
 * shape (band color + dot + label) so the visual vocabulary across admin
 * stays consistent. solicitado=amber (pending action), aprovado=emerald
 * (settled / journal entry).
 * --------------------------------------------------------------------- */

type ChipPalette = {
  border: string;
  bg: string;
  text: string;
  dot: string;
};

const STATUS_PALETTE: Record<RepasseStatus, ChipPalette> = {
  solicitado: {
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
};

/* -----------------------------------------------------------------------
 * Table
 * --------------------------------------------------------------------- */

function RepassesTable({ rows }: { rows: readonly RepasseListRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-paper">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line bg-cream-2/40">
            <TableHeader>campanha</TableHeader>
            <TableHeader>recebedor</TableHeader>
            <TableHeader align="right">valor</TableHeader>
            <TableHeader align="right">lançamentos</TableHeader>
            <TableHeader>solicitado em</TableHeader>
            <TableHeader>status</TableHeader>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <RepasseRow key={row.idRepasse} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableHeader({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
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

function RepasseRow({ row }: { row: RepasseListRow }) {
  const href = `/admin/repasses/${row.idRepasse}`;
  return (
    <tr className="border-b border-line transition-colors last:border-b-0 hover:bg-lilac-soft/30">
      <td className="px-4 py-3">
        <a href={href} className="text-[13px] text-ink hover:text-plum">
          {row.campanhaTitulo}
        </a>
      </td>
      <td className="px-4 py-3 text-[13px] text-ink-soft">
        {row.recebedorNome === null ? (
          <span className="italic text-ink-mute">(sem recebedor)</span>
        ) : (
          row.recebedorNome
        )}
      </td>
      <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink">
        {formatBRL(row.amountCents)}
      </td>
      <td className="px-4 py-3 text-right font-mono text-[12px] tabular-nums text-ink-soft">
        {row.numLancamentos}
      </td>
      <td className="px-4 py-3 font-mono text-[12px] tabular-nums text-ink-soft">
        {formatShortDate(row.solicitadoEm)}
      </td>
      <td className="px-4 py-3">
        <StatusPill status={row.status} />
      </td>
    </tr>
  );
}

function StatusPill({ status }: { status: RepasseStatus }) {
  const palette = STATUS_PALETTE[status];
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em]",
        palette.border,
        palette.bg,
        palette.text,
      ].join(" ")}
    >
      <span
        aria-hidden
        className={`inline-block size-[6px] rounded-full ${palette.dot}`}
      />
      {status}
    </span>
  );
}

/* -----------------------------------------------------------------------
 * States
 * --------------------------------------------------------------------- */

function LoadingState() {
  return (
    <div className="space-y-3 rounded-md border border-line bg-paper p-5">
      <div className="h-4 w-64 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-48 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-56 animate-pulse rounded bg-cream-2" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em]">erro</p>
      <p className="mt-1">{message}</p>
    </div>
  );
}

function EmptyState({ statusFilter }: { statusFilter: RepasseStatus }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-paper px-5 py-10 text-center">
      <p className="font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
        (sem repasses com status “{statusFilter}”)
      </p>
    </div>
  );
}

/* -----------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------- */

function formatBRL(centavos: number): string {
  const reais = centavos / 100;
  try {
    return reais.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  } catch {
    return `R$ ${reais.toFixed(2)}`;
  }
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
}
