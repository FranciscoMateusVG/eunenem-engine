import { useCallback, useEffect, useState } from "react";
import JsonViewer from "@/components/eunenem/admin/JsonViewer";
import LancamentosBlock, {
  type LancamentoRow,
} from "@/components/eunenem/admin/LancamentosBlock";
import { PagamentoWebhookList } from "@/components/eunenem/admin/PagamentoWebhookList";
import { trpc } from "@/lib/trpc.js";

/**
 * PagamentosList — plan 0015 BC reshape, Financeiro folded in (aperture-c5vq2).
 *
 * Renders every pagamento attempt against a contribuicao, sorted criadoEm
 * DESC so the latest attempt sits first. Visitor-retry flows
 * (pendente → processing → aprovado, or pendente → rejeitado → new pendente
 * → aprovado, or aprovado → estornado) get every step in the card stack.
 *
 * Phase 6 reshape — two visible changes vs the rsidz.5 ship:
 *
 *   1. Inline ContribuinteBlock per pagamento. Contribuinte data moved off
 *      Contribuicao onto IntencaoPagamento (Locked Decision #3). Each card
 *      now surfaces { nome, email, mensagem } in a dedicated block, since
 *      different pagamento attempts on the same contribuicao can have
 *      different contribuintes (or null for in-flight pendente rows whose
 *      visitor hasn't completed the Stripe iframe yet).
 *
 *   2. 5-state StatusPill. The Pagamento FSM gained `processing`
 *      (pix QR scanned, ACH float — distinct from `pendente` which is
 *      "intent created, no Stripe activity") and `estornado` (full refund
 *      after aprovado — pre-transfer guard enforced upstream). Visual
 *      palette: processing=amber, estornado=stone (muted past-tense).
 *
 * Visual language matches W0..W4 admin sections — `font-mono` small-caps
 * labels, `text-[13px] text-ink` body, hairline `border-line` cards.
 *
 * The composição breakdown is a structured 6-row table — high-signal
 * payload of the screen, dedicated grid. JsonViewer below it surfaces the
 * raw VO snapshots (composicaoValores, transacaoExterna, intencao) —
 * collapsed by default.
 *
 * Parallel-prep stub: `intencao.contribuinte` arrives as null on every
 * row until Rex's Phase 1 + Phase 3 (entity surgery + webhook handler)
 * ship. The ContribuinteBlock renders the "(sem contribuinte ainda)"
 * affordance for null — same shape as the anonymous-checkout path.
 *
 * Plan 0015 BC reshape (aperture-c5vq2 layered on top of Phase 6):
 *   Financeiro is no longer a sibling section — it's a MODULE inside
 *   Pagamentos. Each PagamentoCard now nests a <LancamentosBlock /> that
 *   renders the triple-entry ledger booked by THIS pagamento. The wire
 *   shape carries the lancamentos slice on each PagamentoAdminDTO; the
 *   standalone `trpc.admin.financeiro.listByContribuicao` is deprecated
 *   on the server (additive — kept on the wire, no UI consumer).
 *
 *   Visual hierarchy inside each card:
 *     CardHeader (status + amount + criadoEm)
 *     CompactRow (método + external ref)
 *     ContribuinteBlock (who paid)
 *     ComposicaoTable (what was paid — the price breakdown)
 *     LancamentosBlock (what was booked — the financeiro ledger)  ← NEW
 *     ExpandToggle / JsonViewer drawer (debug shelf, collapsed)
 *     PagamentoWebhookList (diagnostic webhook trail)
 *
 *   Rationale: composição shows WHAT the contribuinte paid; the ledger
 *   shows WHAT the platform booked. They're conceptual partners — reading
 *   them adjacent makes the double-entry discipline legible at a glance.
 *   The debug drawer + webhook trail follow as lower-signal diagnostics.
 */
export default function PagamentosList({
  idContribuicao,
  onWebhookIssueCountChange,
}: {
  idContribuicao: string;
  /**
   * Called whenever the aggregate webhook-issue count (across all
   * pagamento cards) changes. PagamentosSection uses this to render its
   * "⚠ N webhooks com erro" header chip without a server-side aggregate
   * (aperture-pf348 §quick-scan affordance).
   */
  onWebhookIssueCountChange?: (count: number) => void;
}) {
  const { data, isLoading, error } =
    trpc.admin.pagamentos.listByContribuicao.useQuery({ idContribuicao });

  /**
   * Per-pagamento issue count map. Each PagamentoCard's webhook subsection
   * reports its own count up; we sum the map values + push to the parent
   * (PagamentosSection). useState (not useRef) so the sum recomputes on
   * each card's update.
   */
  const [issueCountsByPagamento, setIssueCountsByPagamento] = useState<
    Record<string, number>
  >({});

  const reportIssueCount = useCallback(
    (idPagamento: string, count: number) => {
      setIssueCountsByPagamento((prev) => {
        if (prev[idPagamento] === count) return prev;
        return { ...prev, [idPagamento]: count };
      });
    },
    [],
  );

  // Push aggregate up to PagamentosSection whenever the sum changes.
  // Effect (not inline call) avoids infinite render loops — the parent
  // owns the setState; we just notify on change.
  const total = Object.values(issueCountsByPagamento).reduce(
    (a, b) => a + b,
    0,
  );
  useEffect(() => {
    onWebhookIssueCountChange?.(total);
  }, [total, onWebhookIssueCountChange]);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!data || data.pagamentos.length === 0) return <EmptyState />;

  return (
    <div className="space-y-4">
      {data.pagamentos.map((p) => (
        <PagamentoCard
          key={p.id}
          pagamento={p}
          onWebhookIssueCountChange={(count) => reportIssueCount(p.id, count)}
        />
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

// Phase 6 — 5-state Pagamento FSM per plan 0015 Locked Decision #7.
type PagamentoStatus =
  | "pendente"
  | "processing"
  | "aprovado"
  | "rejeitado"
  | "estornado";

type ContribuinteBlockData = {
  nome: string;
  email: string;
  mensagem: string | null;
} | null;

type PagamentoDTO = {
  id: string;
  status: PagamentoStatus;
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
    // Plan 0015 Phase 1+3 — DadosContribuinte attached to IntencaoPagamento.
    // Null until the webhook handler populates it at
    // `checkout.session.completed` (Stripe custom_fields delivery).
    contribuinte: ContribuinteBlockData;
  };
  transacaoExterna?: {
    id: string;
    provedor: string;
    status: "aprovado" | "rejeitado";
    amountCents: number;
    criadaEm: string;
    statusBruto?: string;
  };
  /**
   * Plan 0015 BC reshape (aperture-c5vq2) — Financeiro folded into
   * Pagamentos. The triple-entry ledger booked by THIS pagamento ships
   * inline on the DTO. Empty array for non-aprovado pagamentos. See the
   * `LancamentosBlock` component for the rendering contract.
   */
  lancamentos: readonly LancamentoRow[];
};

function PagamentoCard({
  pagamento,
  onWebhookIssueCountChange,
}: {
  pagamento: PagamentoDTO;
  onWebhookIssueCountChange?: (count: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="space-y-4 rounded-md border border-line bg-paper p-5">
      <CardHeader pagamento={pagamento} />
      <CompactRow pagamento={pagamento} />
      <ContribuinteBlock contribuinte={pagamento.intencao.contribuinte} />
      <ComposicaoTable composicao={pagamento.intencao.composicaoValores} />
      {/* Plan 0015 BC reshape — Financeiro module inline. Sits adjacent to
          ComposicaoTable because they're conceptual partners: composição
          shows what the contribuinte PAID, lancamentos show what the
          platform BOOKED. The double-entry discipline reads at a glance. */}
      <LancamentosBlock
        pagamentoStatus={pagamento.status}
        lancamentos={pagamento.lancamentos}
      />
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
      {/* Webhook event trail (aperture-pf348) — sub-diagnostics below the
          domain VO snapshots. Collapsed by default; reports issue count
          upward so the section header can render the aggregate alert. */}
      <PagamentoWebhookList
        idPagamento={pagamento.id}
        onIssueCountChange={onWebhookIssueCountChange}
      />
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

/**
 * Per-pagamento contribuinte block. Plan 0015 Phase 6 — DadosContribuinte
 * moved off Contribuicao onto IntencaoPagamento, so each pagamento card
 * shows its own contribuinte inline. Three states:
 *
 *   1. NULL (parallel-prep stub OR anonymous checkout OR pre-webhook
 *      pendente) → "(sem contribuinte ainda)" italic affordance. The same
 *      shape as the legacy Arrecadação ContribuinteBlock's anonymous-state
 *      so the visual identity carries over.
 *
 *   2. Identified, no mensagem → nome + email only, no quote block.
 *
 *   3. Identified + mensagem → nome + email + italicized quote block
 *      underneath, matching the rsidz.4 MensagemBlock typography
 *      (`text-[14px] italic leading-relaxed text-ink-soft`).
 *
 * Visual identity matches W3's old SubGrid ContribuinteBlock — same
 * small-caps label, same nome+email stack — but here it lives inside a
 * pagamento card instead of the parent contribuicao. Operators see "this
 * specific attempt was from <X>" instead of "this contribuicao slot was
 * bound to <X>".
 */
function ContribuinteBlock({
  contribuinte,
}: {
  contribuinte: ContribuinteBlockData;
}) {
  return (
    <div className="border-t border-line pt-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        contribuinte
      </p>
      {contribuinte === null ? (
        <p className="mt-1 text-[13px] italic text-ink-mute">
          (sem contribuinte ainda)
        </p>
      ) : (
        <div className="mt-1 space-y-2">
          <div className="space-y-0.5">
            <p className="text-[13px] text-ink">{contribuinte.nome}</p>
            <p className="font-mono text-[12px] text-ink-soft">
              {contribuinte.email}
            </p>
          </div>
          {contribuinte.mensagem !== null && contribuinte.mensagem !== "" && (
            <blockquote className="border-l-2 border-line pl-3">
              <p className="text-[13.5px] italic leading-relaxed text-ink-soft">
                “{contribuinte.mensagem}”
              </p>
            </blockquote>
          )}
        </div>
      )}
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

/**
 * 5-state StatusPill per plan 0015 Phase 6.
 *
 * Visual palette — chosen to make the FSM legible at a glance:
 *
 *   pendente    → zinc     (created, no Stripe motion — same neutral as before)
 *   processing  → amber    (in-flight; pix QR scanned / ACH float)
 *                          NEW — distinct yellow band reads as "money is
 *                          moving but not settled". Treats the pix mid-state
 *                          as a first-class status, not a synonym for pendente.
 *   aprovado    → emerald  (success, money settled)
 *   rejeitado   → red      (failed before/during processing)
 *   estornado   → stone    NEW — muted grey-tan band reads as "past tense"
 *                          (the pagamento was successful AND THEN refunded;
 *                          visually distinct from rejeitado which never
 *                          succeeded in the first place).
 *
 * Both new bands use the same chip shape, padding, and `size-[6px]` dot as
 * the existing three — only the color band differs. No layout change.
 */
function StatusPill({
  status,
}: {
  status: PagamentoStatus;
}) {
  const palette = {
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
      label: "processing",
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
