import { trpc } from "@/lib/trpc.js";

/**
 * LancamentosList — plan 0015 Phase 6 reshape (aperture-i45g5).
 *
 * Triple-entry ledger surface on the contribuicao detail page. Renders one
 * block per pagamento; each aprovado pagamento books:
 *
 *   - Saldo do recebedor       (credito_saldo_recebedor)        — always
 *   - Receita da plataforma    (credito_receita_plataforma)     — always
 *   - Repasse Stripe (taxa cartão) (credito_passthrough_surcharge) — cartão only
 *
 * Cartão pagamentos book THREE lancamentos; PIX pagamentos book TWO (no
 * surcharge → no passthrough row at all; absence is semantically correct,
 * not a corruption signal). Keying by tipo means a degenerate
 * recebedor/plataforma slot renders an explicit "(não registrado)" so the
 * double-entry expectation stays visible; the passthrough row's absence is
 * normal PIX-path data and renders nothing.
 *
 * Phase 6 reshape — Lançamento has NO FSM (Locked Decision #9). The status
 * pill + maturação affordance from rsidz.6 / ukmea are GONE. Each row now
 * shows two observed timestamps:
 *
 *   TRANSFERIDO EM — when admin marked the row as transferred to the
 *     recebedor (manual action; no cron yet). `—` if null.
 *   CANCELADO EM   — when the parent pagamento went `estornado` AND this
 *     lancamento was still untransferred (estorno gate returns 409 if any
 *     lancamento has transferidoEm set, so transferred + cancelled is
 *     an impossible pair). `—` if null.
 *
 * Implicit "states" become query-time predicates the operator reads off
 * the timestamp pair:
 *   pending     = transferidoEm = — AND canceladoEm = —
 *   transferred = transferidoEm = <date> AND canceladoEm = —
 *   cancelado   = canceladoEm = <date>
 *
 * Why this is honest DDD: predicted dates (maturaEm) desync from reality;
 * observed dates (transferidoEm / canceladoEm) don't. We store what
 * happened, not what we guessed would happen.
 *
 * Pendente / processing / rejeitado pagamentos book ZERO lancamentos; the
 * block renders the "Sem lançamentos (pagamento ainda não aprovado)"
 * affordance instead of an empty body.
 *
 * Wire shape:
 *   trpc.admin.financeiro.listByContribuicao({ idContribuicao })
 *     → { lancamentosByPagamento: [{ idPagamento, pagamentoStatus,
 *         pagamentoCriadoEm, lancamentos: [...] }] }
 *
 * Parallel-prep stub: until Rex's Phase 1 entity surgery wires the new
 * columns through the LancamentoFinanceiro entity, transferidoEm +
 * canceladoEm arrive as null on every row — both timestamps render as `—`.
 * No UI change needed when the data starts flowing.
 *
 * Visual language matches W0..W4 admin sections — font-mono small-caps
 * labels, hairline borders, BRL formatted via Intl.NumberFormat pt-BR.
 */
export function LancamentosList({
  idContribuicao,
}: {
  idContribuicao: string;
}) {
  const { data, isLoading, error } =
    trpc.admin.financeiro.listByContribuicao.useQuery({ idContribuicao });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!data) return null;

  const groups = data.lancamentosByPagamento;

  if (groups.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <PagamentoBlock
          key={g.idPagamento}
          idPagamento={g.idPagamento}
          pagamentoStatus={g.pagamentoStatus}
          pagamentoCriadoEm={g.pagamentoCriadoEm}
          lancamentos={g.lancamentos}
        />
      ))}
    </div>
  );
}

type Tipo =
  | "credito_saldo_recebedor"
  | "credito_receita_plataforma"
  | "credito_passthrough_surcharge";

// Phase 6 — 5-state Pagamento FSM per Locked Decision #7. processing +
// estornado are the new states surfaced on the parent pagamento header chip.
// Lancamentos themselves have no FSM (Locked Decision #9).
type PagamentoStatus =
  | "pendente"
  | "processing"
  | "aprovado"
  | "rejeitado"
  | "estornado";

type LancamentoRow = {
  id: string;
  idPagamento: string;
  idContribuicao: string;
  idCampanha: string | null;
  tipo: Tipo;
  amountCents: number;
  criadoEm: string;
  /** ISO. When admin marked the row as transferred to the recebedor.
   * Null = not yet transferred (or never will be, if the parent
   * pagamento went estornado before transfer). */
  transferidoEm: string | null;
  /** ISO. When the parent pagamento transitioned to estornado AND this
   * lancamento was still untransferred. Null = not cancelled. The
   * 409-on-estorno-after-transfer rule means transferred + cancelado
   * is an impossible pair. */
  canceladoEm: string | null;
};

function LoadingState() {
  return (
    <div className="space-y-3 rounded-md border border-line bg-paper p-5">
      <div className="h-4 w-56 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-72 animate-pulse rounded bg-cream-2" />
      <div className="h-3 w-40 animate-pulse rounded bg-cream-2" />
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
    <div className="rounded-md border border-dashed border-line bg-paper px-5 py-10 text-center">
      <p className="font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
        (sem pagamentos para esta contribuição — nenhum lançamento financeiro
        gerado)
      </p>
    </div>
  );
}

function PagamentoBlock({
  idPagamento,
  pagamentoStatus,
  pagamentoCriadoEm,
  lancamentos,
}: {
  idPagamento: string;
  pagamentoStatus: PagamentoStatus;
  pagamentoCriadoEm: string;
  lancamentos: readonly LancamentoRow[];
}) {
  return (
    <div className="rounded-md border border-line bg-paper">
      <BlockHeader
        idPagamento={idPagamento}
        pagamentoStatus={pagamentoStatus}
        pagamentoCriadoEm={pagamentoCriadoEm}
      />
      <BlockBody pagamentoStatus={pagamentoStatus} lancamentos={lancamentos} />
    </div>
  );
}

function BlockHeader({
  idPagamento,
  pagamentoStatus,
  pagamentoCriadoEm,
}: {
  idPagamento: string;
  pagamentoStatus: PagamentoStatus;
  pagamentoCriadoEm: string;
}) {
  const shortId = `${idPagamento.slice(0, 8)}…`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        pagamento
      </p>
      <code
        title={idPagamento}
        className="rounded bg-cream-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-soft"
      >
        {shortId}
      </code>
      <span className="font-mono text-[11px] tabular-nums text-ink-soft">
        {formatCriadaEm(pagamentoCriadoEm)}
      </span>
      <span className="ml-auto">
        <PagamentoStatusChip status={pagamentoStatus} />
      </span>
    </div>
  );
}

function BlockBody({
  pagamentoStatus,
  lancamentos,
}: {
  pagamentoStatus: PagamentoStatus;
  lancamentos: readonly LancamentoRow[];
}) {
  if (pagamentoStatus !== "aprovado") {
    return (
      <div className="px-5 py-5">
        <p className="font-mono text-[12px] italic tracking-[0.04em] text-ink-mute">
          Sem lançamentos (pagamento ainda não aprovado)
        </p>
      </div>
    );
  }

  // Aprovado path. Slots are keyed by tipo so the visual order is stable
  // across renders — "Saldo do recebedor" first, "Receita da plataforma"
  // second, "Repasse Stripe (taxa cartão)" third when present.
  //
  // The recebedor + plataforma rows ALWAYS render: if one is missing in
  // the data (corruption / partial save), the slot still renders with
  // "(não registrado)" so the double-entry expectation stays visible.
  //
  // The passthrough row renders ONLY when the passthrough lancamento is
  // present in the data. PIX pagamentos have surchargeCents=0 → no
  // passthrough lancamento → no third row, no placeholder. Its absence is
  // semantically correct (PIX has no buyer surcharge), not a corruption
  // signal — different shape from the recebedor/plataforma slots.
  const saldoRecebedor =
    lancamentos.find((l) => l.tipo === "credito_saldo_recebedor") ?? null;
  const receitaPlataforma =
    lancamentos.find((l) => l.tipo === "credito_receita_plataforma") ?? null;
  const repasseSurcharge =
    lancamentos.find((l) => l.tipo === "credito_passthrough_surcharge") ?? null;

  return (
    <div className="divide-y divide-line">
      <LancamentoRow
        label="Saldo do recebedor"
        sublabel="credito_saldo_recebedor"
        lancamento={saldoRecebedor}
      />
      <LancamentoRow
        label="Receita da plataforma"
        sublabel="credito_receita_plataforma"
        lancamento={receitaPlataforma}
      />
      {repasseSurcharge !== null && (
        <LancamentoRow
          label="Repasse Stripe (taxa cartão)"
          sublabel="credito_passthrough_surcharge"
          lancamento={repasseSurcharge}
        />
      )}
    </div>
  );
}

function LancamentoRow({
  label,
  sublabel,
  lancamento,
}: {
  label: string;
  sublabel: string;
  lancamento: LancamentoRow | null;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-2 px-5 py-4 transition-colors hover:bg-lilac-soft/30">
      <div className="space-y-0.5">
        <p className="text-[13px] text-ink">{label}</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
          {sublabel}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        {lancamento === null ? (
          <p className="text-[13px] italic text-ink-mute">(não registrado)</p>
        ) : (
          <span className="font-mono text-[13px] tabular-nums text-ink">
            {formatBRL(lancamento.amountCents)}
          </span>
        )}
      </div>
      {lancamento !== null && (
        <div className="col-span-2 mt-1">
          <TimestampPair
            transferidoEm={lancamento.transferidoEm}
            canceladoEm={lancamento.canceladoEm}
          />
        </div>
      )}
    </div>
  );
}

/**
 * TRANSFERIDO EM / CANCELADO EM observed-date pair — plan 0015 Phase 6.
 *
 * Replaces the rsidz.6 LancamentoStatusBadge + ukmea maturação affordance.
 * Two timestamp cells side-by-side, each with a small-caps label, a
 * tabular-num value, and `—` when the date is null. Subtle visual treatment
 * for the cancelled case (rose tint on the date) so a glance distinguishes
 * "transferred-and-fine" from "estorned-and-rolled-back".
 *
 * Why two columns instead of a stacked list:
 *   - They're conceptually paired (the lifecycle pivot is whether the
 *     timestamp landed BEFORE the parent pagamento's estorno).
 *   - The 409 guard means transferred + cancelled is impossible — the pair
 *     reads as mutually exclusive at a glance.
 *   - Three implicit states (pending / transferred / cancelado) compose
 *     from two columns with `—`; no separate badge needed.
 */
function TimestampPair({
  transferidoEm,
  canceladoEm,
}: {
  transferidoEm: string | null;
  canceladoEm: string | null;
}) {
  const isCancelled = canceladoEm !== null;
  return (
    <dl className="grid grid-cols-2 gap-x-6">
      <div>
        <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
          transferido em
        </dt>
        <dd className="mt-0.5">
          {transferidoEm === null ? (
            <span className="font-mono text-[12px] text-ink-mute">—</span>
          ) : (
            <span className="font-mono text-[12px] tabular-nums text-emerald-700">
              {formatObservedTimestamp(transferidoEm)}
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
          cancelado em
        </dt>
        <dd className="mt-0.5">
          {canceladoEm === null ? (
            <span className="font-mono text-[12px] text-ink-mute">—</span>
          ) : (
            <span
              title="Pagamento estornado antes do repasse — lançamento cancelado em cascata"
              className={[
                "font-mono text-[12px] tabular-nums",
                isCancelled ? "text-rose-700" : "text-ink",
              ].join(" ")}
            >
              {formatObservedTimestamp(canceladoEm)}
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function PagamentoStatusChip({ status }: { status: PagamentoStatus }) {
  // Plan 0015 Phase 6 — 5-state mini chip. Same shape + sizing as W4's
  // pagamento chip palette so the visual language reads the same across BCs.
  //
  //   aprovado    → emerald  (success, money settled)
  //   processing  → amber    (in-flight; pix QR scanned, ACH float)
  //   pendente    → zinc     (created, no Stripe activity yet)
  //   rejeitado   → rose     (failed before/during processing)
  //   estornado   → stone    (refunded after aprovado; muted to read as past-tense)
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em]",
        pagamentoChipPalette(status).pill,
      ].join(" ")}
    >
      <span
        aria-hidden
        className={`inline-block size-[6px] rounded-full ${pagamentoChipPalette(status).dot}`}
      />
      {status}
    </span>
  );
}

/**
 * Shared palette map for the 5-state pagamento chip. Hoisted so the same
 * lookup is used by LancamentosList here AND by PagamentosList's StatusPill —
 * both render the same five states with the same colors.
 */
function pagamentoChipPalette(status: PagamentoStatus): {
  pill: string;
  dot: string;
} {
  switch (status) {
    case "aprovado":
      return {
        pill: "border-emerald-200 bg-emerald-50 text-emerald-800",
        dot: "bg-emerald-500",
      };
    case "processing":
      return {
        pill: "border-amber-200 bg-amber-50 text-amber-800",
        dot: "bg-amber-500",
      };
    case "rejeitado":
      return {
        pill: "border-rose-200 bg-rose-50 text-rose-800",
        dot: "bg-rose-500",
      };
    case "estornado":
      return {
        pill: "border-stone-300 bg-stone-100 text-stone-700",
        dot: "bg-stone-500",
      };
    case "pendente":
    default:
      return {
        pill: "border-line bg-cream-2 text-ink-soft",
        dot: "bg-ink-mute",
      };
  }
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

/**
 * Observed-timestamp formatter for the TRANSFERIDO EM / CANCELADO EM pair
 * (plan 0015 Phase 6). Canonical format is `DD/MM/YYYY, HH:MM` matching the
 * spec example. Distinct from `formatCriadaEm` which uses a Portuguese
 * short-month abbreviation for the pagamento block header.
 *
 * Locale-aware via Intl.DateTimeFormat; falls back to a deterministic
 * `yyyy-MM-dd HH:mm` string if the runtime lacks Intl.
 */
function formatObservedTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
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

function formatCriadaEm(iso: string): string {
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
