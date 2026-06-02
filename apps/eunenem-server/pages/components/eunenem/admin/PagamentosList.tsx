import { useState } from "react";
import JsonViewer from "@/components/eunenem/admin/JsonViewer";
import { trpc } from "@/lib/trpc.js";

/**
 * PagamentosList — W4 fill for the PagamentosSection (aperture-rsidz.5).
 *
 * Renders every pagamento attempt against a contribuicao, sorted criadoEm
 * DESC so the latest attempt sits first. Visitor-retry flows
 * (pendente → rejeitado → new pendente → aprovado) get every step in the
 * card stack — the operator can see the full lifecycle without leaving the
 * page.
 *
 * Visual language matches W0/W1/W2/W3:
 *   - `font-mono` labels at `text-[11px] uppercase tracking-[0.14em] text-ink-soft`
 *   - `text-[13px] text-ink` body
 *   - hairline `border-line`, `bg-paper` cards
 *   - the same status-pill shape as ArrecadacaoSection's `StatusPill`
 *
 * The composição breakdown is a structured 6-row table — it's the high-
 * signal payload of the screen, so it gets a dedicated grid. The
 * JsonViewer below it is for operator inspection of the raw VO snapshots
 * (composicaoValores, transacaoExterna, intencao) — collapsed by default
 * because the screen would otherwise drown in JSON.
 */
export default function PagamentosList({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  const { data, isLoading, error } =
    trpc.admin.pagamentos.listByContribuicao.useQuery({ idContribuicao });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!data || data.pagamentos.length === 0) return <EmptyState />;

  return (
    <div className="space-y-4">
      {data.pagamentos.map((p) => (
        <PagamentoCard key={p.id} pagamento={p} />
      ))}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3 rounded-md border border-line bg-paper p-5">
      <div className="h-4 w-48 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-64 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-32 animate-pulse rounded bg-cream-2" />
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
    <div className="rounded-md border border-line bg-paper px-5 py-10 text-center">
      <p className="font-mono text-[13px] italic tracking-[0.02em] text-ink-mute">
        (sem pagamentos para esta contribuição)
      </p>
    </div>
  );
}

type PagamentoDTO = {
  id: string;
  status: "pendente" | "aprovado" | "rejeitado";
  criadoEm: string;
  atualizadoEm: string;
  intencao: {
    id: string;
    idContribuicao: string;
    amountCents: number;
    metodo: "pix" | "credit_card";
    externalRef: string | null;
    criadaEm: string;
    composicaoValores: {
      idContribuicao: string;
      contributionAmountCents: number;
      feeAmountCents: number;
      surchargeCents: number;
      totalPaidCents: number;
      receiverAmountCents: number;
      responsavelTaxa: "contribuinte";
    };
  };
  transacaoExterna?: {
    id: string;
    provedor: string;
    status: "aprovado" | "rejeitado";
    amountCents: number;
    criadaEm: string;
    statusBruto?: string;
  };
};

function PagamentoCard({ pagamento }: { pagamento: PagamentoDTO }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="space-y-4 rounded-md border border-line bg-paper p-5">
      <CardHeader pagamento={pagamento} />
      <CompactRow pagamento={pagamento} />
      <ComposicaoTable composicao={pagamento.intencao.composicaoValores} />
      <ExpandToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      {expanded && (
        <div className="space-y-3 border-t border-line pt-4">
          <JsonViewer
            label="composicaoValores"
            data={pagamento.intencao.composicaoValores}
          />
          {pagamento.transacaoExterna && (
            <JsonViewer
              label="transacaoExterna"
              data={pagamento.transacaoExterna}
            />
          )}
          <JsonViewer label="intencao (raw)" data={pagamento.intencao} />
        </div>
      )}
    </article>
  );
}

function CardHeader({ pagamento }: { pagamento: PagamentoDTO }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex items-center gap-3">
        <StatusPill status={pagamento.status} />
        <span className="font-mono text-[15px] tabular-nums text-ink">
          {formatBRL(pagamento.intencao.amountCents)}
        </span>
      </div>
      <span className="font-mono text-[12px] tabular-nums text-ink-soft">
        {formatCriadoEmShort(pagamento.criadoEm)}
      </span>
    </div>
  );
}

function CompactRow({ pagamento }: { pagamento: PagamentoDTO }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
      <FactRow label="método" value={<MetodoChip metodo={pagamento.intencao.metodo} />} />
      <FactRow
        label="external ref"
        value={
          pagamento.intencao.externalRef === null ? (
            <span className="text-[13px] italic text-ink-mute">(sem referência)</span>
          ) : (
            <ExternalRefChip externalRef={pagamento.intencao.externalRef} />
          )
        }
      />
    </dl>
  );
}

function ComposicaoTable({
  composicao,
}: {
  composicao: PagamentoDTO["intencao"]["composicaoValores"];
}) {
  const rows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "Contribuição",
      value: <BrlValue cents={composicao.contributionAmountCents} />,
    },
    {
      label: "Taxa plataforma",
      value: <BrlValue cents={composicao.feeAmountCents} />,
    },
    {
      label: "Acréscimo cartão (visitante)",
      value: <BrlValue cents={composicao.surchargeCents} />,
    },
    {
      label: "Total pago",
      value: <BrlValue cents={composicao.totalPaidCents} emphasis />,
    },
    {
      label: "Líquido ao recebedor",
      value: <BrlValue cents={composicao.receiverAmountCents} />,
    },
    {
      label: "Responsável pela taxa",
      value: (
        <span className="text-[13px] text-ink">{composicao.responsavelTaxa}</span>
      ),
    },
  ];
  return (
    <div className="border-t border-line pt-4">
      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
        composição de valores
      </p>
      <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[max-content_1fr]">
        {rows.map(({ label, value }) => (
          <div
            key={label}
            className="contents [&>dt]:font-mono [&>dt]:text-[11px] [&>dt]:uppercase [&>dt]:tracking-[0.12em] [&>dt]:text-ink-mute"
          >
            <dt className="pt-1">{label}</dt>
            <dd className="pb-1 sm:pb-0">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ExpandToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="group inline-flex items-center gap-1.5 rounded font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute transition-colors hover:text-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
    >
      <span aria-hidden className="inline-block size-[6px] rounded-full bg-ink-mute group-hover:bg-plum" />
      <span>{expanded ? "ocultar json" : "expandir json"}</span>
    </button>
  );
}

function BrlValue({
  cents,
  emphasis = false,
}: {
  cents: number;
  emphasis?: boolean;
}) {
  return (
    <span
      className={[
        "font-mono tabular-nums",
        emphasis ? "text-[13px] text-ink" : "text-[12px] text-ink-soft",
      ].join(" ")}
    >
      {formatBRL(cents)}
    </span>
  );
}

function FactRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="contents [&>dt]:font-mono [&>dt]:text-[11px] [&>dt]:uppercase [&>dt]:tracking-[0.12em] [&>dt]:text-ink-mute">
      <dt className="pt-1">{label}</dt>
      <dd className="pb-1 sm:pb-0">{value}</dd>
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: "pendente" | "aprovado" | "rejeitado";
}) {
  const palette = {
    pendente: {
      border: "border-line",
      bg: "bg-cream-2",
      text: "text-ink-soft",
      dot: "bg-ink-mute",
      label: "pendente",
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
  }[status];
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em]",
        palette.border,
        palette.bg,
        palette.text,
      ].join(" ")}
    >
      <span aria-hidden className={`inline-block size-[6px] rounded-full ${palette.dot}`} />
      {palette.label}
    </span>
  );
}

function MetodoChip({ metodo }: { metodo: "pix" | "credit_card" }) {
  const label = metodo === "credit_card" ? "cartão" : "pix";
  return (
    <span className="inline-flex items-center rounded border border-line bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
      {label}
    </span>
  );
}

/**
 * External-ref short hash + click-to-copy. Mirrors W3's IdCopyChip shape,
 * but the prefix length is bumped to 12 so a Stripe `cs_test_…` session id
 * surfaces enough chars to be operator-recognisable at a glance.
 *
 * SSR-safe — falls back to a plain code span when navigator.clipboard is
 * unavailable (older browsers / non-secure contexts).
 */
function ExternalRefChip({ externalRef }: { externalRef: string }) {
  const [copied, setCopied] = useState(false);
  const shortRef =
    externalRef.length > 14 ? `${externalRef.slice(0, 12)}…` : externalRef;

  const canCopy =
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function";

  const onClick = async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(externalRef);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silently ignore — no UX surface for clipboard errors in admin v1.
    }
  };

  if (!canCopy) {
    return (
      <code className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
        {shortRef}
      </code>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "copiado" : `Copiar ${externalRef}`}
      aria-label={copied ? "Referência copiada" : `Copiar referência externa: ${externalRef}`}
      className="group inline-flex items-center gap-1.5 rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-soft transition-colors hover:text-plum focus:outline-none focus:ring-2 focus:ring-lilac-soft"
    >
      <span>{shortRef}</span>
      <span
        aria-hidden
        className={[
          "font-mono text-[9px] uppercase tracking-[0.18em]",
          copied ? "text-emerald-600" : "text-ink-mute group-hover:text-plum",
        ].join(" ")}
      >
        {copied ? "copiado" : "copiar"}
      </span>
    </button>
  );
}

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

function formatCriadoEmShort(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${hh}:${mm}`;
  }
}
