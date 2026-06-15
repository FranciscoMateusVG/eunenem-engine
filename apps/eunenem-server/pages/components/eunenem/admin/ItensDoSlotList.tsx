import { DddBadge } from "@/components/eunenem/admin/DddBadge";
import { trpc } from "@/lib/trpc.js";

/**
 * ItensDoSlotList — Plan 0017 / aperture-gf2t5.
 *
 * The "aggregate context restored" view on /admin/contribuicao/:id. Lists
 * every ItemDoPagamento across every pagamento that referenced this
 * contribuição slot — answering the operator's "I see only one pagamento
 * even though 5 of 6 were sold" pain.
 *
 * One row per item-row (not per pagamento — multi-item carts surface only
 * their slot-relevant line here). Click a row → /admin/pagamento/:id (full
 * detail).
 *
 * Data: `admin.contribuicoes.listItemsByContribuicao` (NEW under gf2t5).
 * Returns rows already sorted DESC by pagamento criadoEm.
 */
type ItemRow = {
  id: string;
  idPagamento: string;
  pagamentoStatus:
    | "pendente"
    | "processing"
    | "aprovado"
    | "rejeitado"
    | "estornado";
  pagamentoCriadoEm: string;
  quantidade: number;
  lineContributionAmountCents: number;
  lineFeeAmountCents: number;
  lineReceiverAmountCents: number;
  contribuinte: { nome: string; email: string; mensagem: string | null } | null;
};

export function ItensDoSlotList({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  const { data, isLoading, error } =
    trpc.admin.contribuicoes.listItemsByContribuicao.useQuery({
      idContribuicao,
    });

  const items: ItemRow[] = data?.items ?? [];

  return (
    <section data-bc="pagamentos" className="space-y-3">
      <Header count={items.length} />
      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message} />}
      {!isLoading && !error && items.length === 0 && <EmptyState />}
      {!isLoading && !error && items.length > 0 && (
        <SummaryBar items={items} />
      )}
      {!isLoading && !error && items.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-md border border-line bg-paper">
          {items.map((row) => (
            <li key={row.id}>
              <a
                href={`/admin/pagamento/${row.idPagamento}`}
                className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-cream-2/40 focus:bg-cream-2/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-plum sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="flex items-center gap-3 sm:min-w-[160px]">
                  <StatusChip status={row.pagamentoStatus} />
                </div>
                <div className="flex flex-1 flex-col gap-0.5">
                  <span className="text-[14px] font-medium text-ink">
                    {row.contribuinte?.nome ?? (
                      <span className="italic text-ink-soft">
                        (sem contribuinte)
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] text-ink-mute">
                    {fmtIso(row.pagamentoCriadoEm)} ·{" "}
                    {row.quantidade}× · pagamento{" "}
                    {row.idPagamento.slice(0, 8)}…
                  </span>
                </div>
                <div className="flex items-center gap-2 sm:justify-end sm:text-right">
                  <span className="font-mono text-[14px] tabular-nums text-ink">
                    {fmtBRL(
                      row.lineContributionAmountCents +
                        row.lineFeeAmountCents,
                    )}
                  </span>
                  <span aria-hidden className="text-ink-mute">
                    ›
                  </span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Header({ count }: { count: number }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-3">
        <DddBadge bc="pagamentos" size="sm" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
          itens do pagamento
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          {count === 0
            ? "0 vendas"
            : count === 1
              ? "1 venda"
              : `${count} vendas`}
        </span>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
        cada linha → seu pagamento
      </span>
    </div>
  );
}

function SummaryBar({ items }: { items: ItemRow[] }) {
  const aprovados = items.filter((i) => i.pagamentoStatus === "aprovado");
  const totalUnitsAprovadas = aprovados.reduce((s, i) => s + i.quantidade, 0);
  const totalAprovadoCents = aprovados.reduce(
    (s, i) => s + i.lineContributionAmountCents + i.lineFeeAmountCents,
    0,
  );
  const pendentes = items.filter(
    (i) =>
      i.pagamentoStatus === "pendente" || i.pagamentoStatus === "processing",
  );
  return (
    <dl className="grid gap-x-6 gap-y-2 rounded-md border border-line bg-paper p-4 sm:grid-cols-3">
      <Stat
        label="vendidas (aprovadas)"
        value={`${totalUnitsAprovadas} ${totalUnitsAprovadas === 1 ? "un" : "uns"}`}
        sub={fmtBRL(totalAprovadoCents)}
      />
      <Stat
        label="em andamento"
        value={`${pendentes.length} pagamento${pendentes.length === 1 ? "" : "s"}`}
      />
      <Stat label="total de linhas" value={`${items.length}`} />
    </dl>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col">
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </dt>
      <dd className="mt-0.5 font-mono text-[14px] tabular-nums text-ink">
        {value}
        {sub && (
          <span className="ml-2 font-mono text-[11px] text-ink-soft">
            {sub}
          </span>
        )}
      </dd>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-2">
      <div className="h-12 animate-pulse rounded-md bg-cream-2" />
      <div className="h-12 animate-pulse rounded-md bg-cream-2" />
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

function EmptyState() {
  return (
    <div className="rounded-md border border-dashed border-line bg-paper px-5 py-8 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        nenhuma venda registrada
      </p>
      <p className="mt-2 text-[13px] text-ink-soft">
        Quando alguém comprar este presente, a linha do pagamento aparecerá
        aqui — uma linha por venda.
      </p>
    </div>
  );
}

// ── Chip palettes ────────────────────────────────────────────────────────

type ChipPalette = {
  border: string;
  bg: string;
  text: string;
  dot: string;
  label: string;
};

const STATUS_CHIP: Record<ItemRow["pagamentoStatus"], ChipPalette> = {
  pendente: {
    border: "border-line",
    bg: "bg-cream-2",
    text: "text-ink-soft",
    dot: "bg-ink-mute",
    label: "pendente",
  },
  processing: {
    border: "border-amber-200",
    bg: "bg-amber-50",
    text: "text-amber-800",
    dot: "bg-amber-500",
    label: "processando",
  },
  aprovado: {
    border: "border-emerald-200",
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    dot: "bg-emerald-500",
    label: "aprovado",
  },
  rejeitado: {
    border: "border-red-200",
    bg: "bg-red-50",
    text: "text-red-800",
    dot: "bg-red-500",
    label: "rejeitado",
  },
  estornado: {
    border: "border-stone-300",
    bg: "bg-stone-100",
    text: "text-stone-700",
    dot: "bg-stone-500",
    label: "estornado",
  },
};

function StatusChip({ status }: { status: ItemRow["pagamentoStatus"] }) {
  const p = STATUS_CHIP[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border ${p.border} ${p.bg} px-2.5 py-[3px] font-mono text-[10px] uppercase tracking-[0.10em] ${p.text}`}
    >
      <span aria-hidden className={`size-[6px] rounded-full ${p.dot}`} />
      {p.label}
    </span>
  );
}

// ── Formatters ───────────────────────────────────────────────────────────

function fmtBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
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
