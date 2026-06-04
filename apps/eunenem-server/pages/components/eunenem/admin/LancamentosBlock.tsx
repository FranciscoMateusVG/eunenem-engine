import { DddBadge } from "@/components/eunenem/admin/DddBadge";

/**
 * LancamentosBlock — plan 0015 BC reshape (Financeiro folded into Pagamentos).
 *
 * Per-pagamento triple-entry ledger surface, lifted out of the standalone
 * FinanceiroSection / LancamentosList pair and reshaped to nest INSIDE each
 * PagamentoCard rendered by PagamentosList. Financeiro is no longer its own
 * BC — it is now a MODULE inside Pagamentos, and the UI mirrors that nesting.
 *
 * Data lifted to the parent: this component takes its lancamentos as PROPS
 * (no tRPC query). The parent pagamento card already owns the pagamento
 * identity (short-id + status pill + amount + criadoEm), so the per-block
 * header that used to live here is gone — duplicating it inside the card
 * would be visual noise. A small DddBadge sub-header strip stays to preserve
 * BC wayfinding: operator sees "this is the Financeiro surface" at a glance.
 *
 * Aprovado pagamentos book:
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
 * Lançamento has NO FSM (Locked Decision #9). Each row shows two observed
 * timestamps:
 *
 *   TRANSFERIDO EM — when admin marked the row as transferred to the
 *     recebedor (manual action; no cron yet). `—` if null.
 *   CANCELADO EM   — when the parent pagamento went `estornado` AND this
 *     lancamento was still untransferred. `—` if null.
 *
 * Cascade-scope discipline: transferred + cancelled is an IMPOSSIBLE pair.
 * The estorno gate returns 409 if any lancamento under the pagamento has
 * transferidoEm set, so cascade cancellation only touches still-pending
 * rows. The TimestampPair therefore reads as mutually exclusive at a glance.
 *
 * Implicit "states" become query-time predicates the operator reads off
 * the timestamp pair:
 *   pending     = transferidoEm = — AND canceladoEm = —
 *   transferred = transferidoEm = <date> AND canceladoEm = —
 *   cancelado   = canceladoEm = <date>
 *
 * Pendente / processing / rejeitado / estornado pagamentos book ZERO
 * lancamentos until aprovado; the block renders the "Sem lançamentos
 * (pagamento ainda não aprovado)" affordance instead of an empty body.
 *
 * Parallel-prep stub: until Rex's Phase 1 entity surgery wires the new
 * columns through the LancamentoFinanceiro entity, transferidoEm +
 * canceladoEm arrive as null on every row — both timestamps render as `—`.
 * No UI change needed when the data starts flowing.
 *
 * Visual language matches W0..W4 admin sections — font-mono small-caps
 * labels, hairline borders, BRL formatted via Intl.NumberFormat pt-BR.
 */

export type Tipo =
  | "credito_saldo_recebedor"
  | "credito_receita_plataforma"
  | "credito_passthrough_surcharge";

// Plan 0015 — 5-state Pagamento FSM per Locked Decision #7. processing +
// estornado are the new states surfaced on the parent pagamento header chip.
// Lancamentos themselves have no FSM (Locked Decision #9).
export type PagamentoStatus =
  | "pendente"
  | "processing"
  | "aprovado"
  | "rejeitado"
  | "estornado";

export type LancamentoRow = {
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

export default function LancamentosBlock({
  pagamentoStatus,
  lancamentos,
}: {
  pagamentoStatus: PagamentoStatus;
  lancamentos: readonly LancamentoRow[];
}) {
  return (
    <div className="rounded-md border border-line bg-paper">
      <div className="flex items-center gap-2 border-b border-line px-5 py-2">
        <DddBadge bc="financeiro" size="sm" />
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-soft">
          financeiro · livro do pagamento
        </p>
      </div>
      <Body pagamentoStatus={pagamentoStatus} lancamentos={lancamentos} />
    </div>
  );
}

function Body({
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
      <LancamentoRowView
        label="Saldo do recebedor"
        sublabel="credito_saldo_recebedor"
        lancamento={saldoRecebedor}
      />
      <LancamentoRowView
        label="Receita da plataforma"
        sublabel="credito_receita_plataforma"
        lancamento={receitaPlataforma}
      />
      {repasseSurcharge !== null && (
        <LancamentoRowView
          label="Repasse Stripe (taxa cartão)"
          sublabel="credito_passthrough_surcharge"
          lancamento={repasseSurcharge}
        />
      )}
    </div>
  );
}

function LancamentoRowView({
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
 * spec example.
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
