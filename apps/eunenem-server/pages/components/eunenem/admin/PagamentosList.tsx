import { useCallback, useEffect, useMemo, useState } from "react";
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
 *     LancamentosBlock (what was booked — the financeiro ledger)
 *     ExpandToggle / JsonViewer drawer (debug shelf, collapsed)
 *     PagamentoWebhookList (diagnostic webhook trail)
 *
 *   Rationale: composição shows WHAT the contribuinte paid; the ledger
 *   shows WHAT the platform booked. They're conceptual partners — reading
 *   them adjacent makes the double-entry discipline legible at a glance.
 *   The debug drawer + webhook trail follow as lower-signal diagnostics.
 *
 * Single-pagamento-view pagination (aperture-d7sxd):
 *   Multi-pagamento contribuicoes (visitor retried; cartão failed then PIX
 *   succeeded; orphan pendentes from abandoned iframes) stack vertically by
 *   default. With 5+ attempts the page reads as visual mess. Solution: render
 *   ONE PagamentoCard at a time with a navigator strip above. The strip
 *   shows every attempt as a status-chip pill — operator sees the full
 *   landscape AND clicks to swap the visible card.
 *
 *   Default selection: most-recent aprovado (the "winning" pagamento), else
 *   most-recent overall (single pendente/processing/rejeitado/estornado).
 *   Implementation keys selection by pagamento.id (not index) so a wire
 *   refetch that reorders the list keeps the operator's selection stable.
 *
 *   ALL cards stay mounted (hidden via `hidden` Tailwind utility on the
 *   non-selected ones). Two reasons:
 *     1. PagamentoWebhookList queries fire for every card → aggregate
 *        "⚠ N webhooks com erro" header chip count stays accurate.
 *     2. Internal card state (expanded JsonViewer drawer) persists across
 *        navigation — operator doesn't lose their place when toggling.
 *   DOM cost is bounded: N ≤ ~10 in realistic admin cases.
 *
 *   Single-pagamento contribuicoes (N=1) hide the navigator entirely — no
 *   UX noise, the card renders as it did pre-d7sxd.
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

  // d7sxd — single-pagamento-view pagination. Selection key is the pagamento
  // id (not index) so a wire refetch that reorders the list keeps operator's
  // selection stable. Default selection: most-recent aprovado, else first.
  const defaultSelectedId = useMemo<string | null>(() => {
    if (!data?.pagamentos.length) return null;
    const firstAprovado = data.pagamentos.find((p) => p.status === "aprovado");
    return firstAprovado?.id ?? data.pagamentos[0]?.id ?? null;
  }, [data]);
  const [explicitSelection, setExplicitSelection] = useState<string | null>(
    null,
  );
  // If the operator picked something explicit, honor that. Otherwise track
  // the data-derived default — which can shift as new pagamentos arrive
  // (e.g. visitor completes a successful retry after we already loaded the
  // page; live query refetch promotes the new aprovado as default).
  const selectedId = explicitSelection ?? defaultSelectedId;

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
  if (!data || data.pagamentos.length === 0) return <EmptyState />;

  const pagamentos = data.pagamentos;

  return (
    <div className="space-y-4">
      {pagamentos.length > 1 && (
        <PagamentoNavigator
          pagamentos={pagamentos}
          selectedId={selectedId}
          onSelect={setExplicitSelection}
        />
      )}
      {pagamentos.map((p) => (
        <div
          key={p.id}
          className={selectedId === p.id ? undefined : "hidden"}
          aria-hidden={selectedId === p.id ? undefined : true}
        >
          <PagamentoCard
            pagamento={p}
            onWebhookIssueCountChange={(count) => reportIssueCount(p.id, count)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Horizontal status-chip strip — one pill per pagamento, click to swap the
 * visible card. Plan 0015 admin pagination (aperture-d7sxd).
 *
 * Each pill shows the StatusPill palette (5-state FSM + liberacao overlay if
 * applicable) + the short-id (8 chars, mono) + criadoEm short date. The
 * active pill gets a filled bg-ink/5 + ring-1 ring-ink/20 to read as
 * "currently selected" without competing with the status color.
 *
 * Why a chip strip vs prev/next chips vs dropdown:
 *   - Prev/next chips lose context ("which of N am I viewing?")
 *   - Dropdown hides the choices behind a click — operator can't scan
 *     statuses without interacting
 *   - Chip strip wins on signal density: status palette IS the navigator
 *     label, dates + short-ids are inline, full landscape visible at a
 *     glance. For N≤~10 (realistic admin case) this scans cleanly; for
 *     pathological N=50 the strip horizontal-scrolls (overflow-x-auto).
 *
 * Single-pagamento contribuicoes never render this — the parent guards on
 * `pagamentos.length > 1`.
 */
function PagamentoNavigator({
  pagamentos,
  selectedId,
  onSelect,
}: {
  pagamentos: readonly PagamentoDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Selecionar pagamento"
      className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1"
    >
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-mute">
        {pagamentos.length} tentativas
      </span>
      <span aria-hidden className="shrink-0 text-ink-mute">
        ·
      </span>
      <ul className="flex shrink-0 items-center gap-1.5">
        {pagamentos.map((p, idx) => (
          <li key={p.id}>
            <NavigatorPill
              pagamento={p}
              ordinal={idx + 1}
              selected={selectedId === p.id}
              onSelect={() => onSelect(p.id)}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

function NavigatorPill({
  pagamento,
  ordinal,
  selected,
  onSelect,
}: {
  pagamento: PagamentoDTO;
  ordinal: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const palette =
    pagamento.liberacao !== null
      ? LIBERACAO_PALETTE[pagamento.liberacao]
      : STATUS_PALETTE[pagamento.status];
  const shortId = `${pagamento.id.slice(0, 8)}…`;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Tentativa ${ordinal} — ${palette.label} — ${shortId}`}
      title={`Tentativa ${ordinal} · ${pagamento.id}`}
      className={[
        "group inline-flex items-center gap-2 rounded-full border px-2.5 py-[3px] font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
        // Status palette controls the BAND color (border + bg + text).
        palette.border,
        palette.bg,
        palette.text,
        // Active state: subtle ring + opacity bump so the chip "lifts" off
        // the strip without changing the underlying status hue.
        selected
          ? "ring-1 ring-ink/30 ring-offset-1 ring-offset-paper"
          : "opacity-60 hover:opacity-100 focus:opacity-100",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={`inline-block size-[6px] rounded-full ${palette.dot}`}
      />
      <span className="tabular-nums">{ordinal}.</span>
      <span>{palette.label}</span>
      <span aria-hidden className="text-ink-mute opacity-70">
        ·
      </span>
      <span className="text-ink-soft normal-case opacity-90">
        {formatNavigatorDate(pagamento.criadoEm)}
      </span>
    </button>
  );
}

/**
 * Navigator-pill date format — `DD/MM` (short). Operator only needs the
 * day/month to disambiguate the attempts. Full ISO is one click away
 * inside each card's CardHeader formatCriadoEmShort.
 */
function formatNavigatorDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit" });
  } catch {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}`;
  }
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

/**
 * Plan 0015 derived-liberacao extension (aperture-mjgxe / aperture-ft5t1).
 *
 * Splits the `aprovado` chip into two sub-states without changing the FSM:
 *
 *   'aguardando_liberacao'  Money received from Stripe but not yet settled
 *                           into the platform's balance (Stripe's T+1 for pix,
 *                           D+30 default for cartão). Server-derived from
 *                           `status='aprovado' AND (availableOn IS NULL OR
 *                           availableOn > now())`.
 *   'disponivel'            Money has settled and can be transferred to the
 *                           recebedor. Derived from `status='aprovado' AND
 *                           availableOn <= now()`.
 *   null                    Pagamento is not aprovado — the chip falls back to
 *                           the status-level palette (pendente / processing /
 *                           rejeitado / estornado).
 *
 * UI never computes the predicate — Rex's backend derives it server-side and
 * ships the resolved value on the wire. The UI just renders.
 */
type LiberacaoState = "aguardando_liberacao" | "disponivel" | null;

type ContribuinteBlockData = {
  nome: string;
  email: string;
  mensagem: string | null;
} | null;

/**
 * Plan 0016 Phase 4 (aperture-3htxg) — per-item discriminated wire shape.
 *
 * Contribuição items carry the joined `contribuicaoNome` (null when the
 * slot has been deleted between the pagamento + this read — orphan items
 * still bill + book) plus per-line denormalised totals. Surcharge items
 * carry only the cart-wide processing fee. Position is preserved verbatim
 * from the domain — contribuição items first, surcharge ALWAYS LAST when
 * present (locked decision #18).
 */
type ItemContribuicaoDTO = {
  id: string;
  tipo: "contribuicao";
  idContribuicao: string;
  contribuicaoNome: string | null;
  quantidade: number;
  lineContributionAmountCents: number;
  lineFeeAmountCents: number;
  lineReceiverAmountCents: number;
};
type ItemSurchargeDTO = {
  id: string;
  tipo: "passthrough_surcharge";
  amountCents: number;
};
type ItemDTO = ItemContribuicaoDTO | ItemSurchargeDTO;

type ComposicaoAggregateDTO = {
  idCampanha: string;
  totalContributionCents: number;
  totalFeeCents: number;
  totalSurchargeCents: number;
  totalReceiverCents: number;
  totalPaidCents: number;
  responsavelTaxa: "contribuinte";
};

type PagamentoDTO = {
  id: string;
  status: PagamentoStatus;
  criadoEm: string;
  atualizadoEm: string;
  intencao: {
    id: string;
    idCampanha: string;
    amountCents: number;
    metodo: "pix" | "credit_card";
    externalRef: string | null;
    criadaEm: string;
    /**
     * Plan 0016 Phase 4: the cart's per-line decomposition. ≥ 1 item.
     * Contribuição items first (in caller-provided order), surcharge
     * item LAST when the pagamento is on the cartão path (PIX flows
     * carry zero surcharge items).
     */
    items: ReadonlyArray<ItemDTO>;
    /**
     * Plan 0016 Phase 4: aggregate composição — sum across items of
     * each per-line component. `totalPaidCents` mirrors the legacy
     * pagamento-level `amountCents`.
     */
    composicaoValoresAggregate: ComposicaoAggregateDTO;
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
  /**
   * Plan 0015 derived-liberacao extension (aperture-mjgxe). When the
   * pagamento is aprovado, the Stripe balance-transaction maturation
   * timestamp tells the UI when the funds become available for transfer
   * to the recebedor. Null for non-aprovado pagamentos (and during the
   * brief window between `charge.succeeded` and the dispatcher persisting
   * `intencao.balanceTransactionAvailableOn` to the DB).
   *
   * Source of truth: `pagamentos.listByContribuicao` projects this from
   * the column populated by the webhook dispatcher (PIX = NOW() inline
   * at `payment_intent.succeeded`; cartão = Stripe API
   * `obterAvailableOnDoCharge` on `charge.balance_transaction`).
   */
  availableOn: string | null;
  /**
   * Plan 0015 derived-liberacao extension (aperture-mjgxe). Server-side
   * derived from (status, availableOn) per the contract in
   * `LiberacaoState`'s doc-block above. Null for non-aprovado pagamentos.
   *
   * Source of truth: server-side at DTO projection time —
   * `pagamentos.listByContribuicao` evaluates the predicate with `now()`
   * against `availableOn` and labels the chip accordingly. UI does no
   * temporal math.
   */
  liberacao: LiberacaoState;
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
      {/* Plan 0016 Phase 4 (aperture-3htxg) — per-item breakdown of the
          cart. Replaces the pre-0016 single-row ComposicaoTable. Reads
          top-to-bottom in the same order the lançamentos rendered below
          it: each contribuição line books 2 lançamentos (recebedor +
          plataforma), the surcharge item (when present, cartão path
          only) books 1 — so a 2-contribuição cartão cart produces
          5 lançamentos total, all under the same pagamento header. */}
      <ItensList items={pagamento.intencao.items} />
      {/* Plan 0016 Phase 4 — aggregate composição, replaces the pre-0016
          single-row composição. Sits between the per-item breakdown and
          the Financeiro module: "what each line cost" → "what the cart
          summed to" → "what the platform booked." */}
      <ComposicaoAgregadaTable
        agregada={pagamento.intencao.composicaoValoresAggregate}
      />
      {/* Plan 0015 BC reshape — Financeiro module inline. Sits adjacent to
          ComposicaoAgregadaTable because they're conceptual partners:
          composição shows what the contribuinte PAID, lancamentos show
          what the platform BOOKED. The double-entry discipline reads at
          a glance even with the multi-item row counts. */}
      <LancamentosBlock
        pagamentoStatus={pagamento.status}
        lancamentos={pagamento.lancamentos}
      />
      <ExpandToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      {expanded && (
        <div className="space-y-3 border-t border-line pt-4">
          <JsonViewer
            label="composicaoValoresAggregate"
            data={pagamento.intencao.composicaoValoresAggregate}
          />
          <JsonViewer label="items" data={pagamento.intencao.items} />
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
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <StatusPill
            status={pagamento.status}
            liberacao={pagamento.liberacao}
          />
          <span className="font-mono text-[15px] tabular-nums text-ink">
            {formatBRL(pagamento.intencao.amountCents)}
          </span>
        </div>
        {pagamento.liberacao === "aguardando_liberacao" &&
          pagamento.availableOn !== null && (
            <LiberacaoSubLabel availableOn={pagamento.availableOn} />
          )}
      </div>
      <span className="font-mono text-[12px] tabular-nums text-ink-soft">
        {formatCriadoEmShort(pagamento.criadoEm)}
      </span>
    </div>
  );
}

/**
 * Sub-label rendered under the StatusPill when the pagamento is aprovado +
 * aguardando_liberacao + has a known availableOn date. Plan 0015 derived-
 * liberacao extension (aperture-mjgxe / aperture-ft5t1).
 *
 * Visual treatment matches the existing PagamentosSection header sublabels
 * (`font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute`) so the
 * card chrome reads cohesively. Date format is DD/MM (short — the operator
 * only needs the day/month at a glance; the full ISO is one click away in
 * the JsonViewer drawer if they need year + time).
 */
function LiberacaoSubLabel({ availableOn }: { availableOn: string }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-mute">
      liberação prevista {formatLiberacaoDate(availableOn)}
    </span>
  );
}

function formatLiberacaoDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
    });
  } catch {
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}`;
  }
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

/**
 * ItensList — Plan 0016 Phase 4 (aperture-3htxg).
 *
 * Per-line decomposition of the cart. Each contribuição item gets a row
 * with: name + `× N` quantidade chip on the left, contribution / fee /
 * receiver as compact value columns on the right. The surcharge item
 * (cartão path only — ALWAYS LAST per locked decision #18) gets its own
 * italic-muted row with just the surcharge amount surfacing, since it's
 * a cart-wide passthrough rather than a per-slot line.
 *
 * Visual rhythm: hairline separators between items, contribuição rows
 * carry the same font weight as the composição totals so the eye reads
 * `items` and `aggregate` as one ledger. The orphan-slot affordance
 * `(contribuição removida)` italic appears when the join misses — same
 * shape as the `(sem contribuinte ainda)` affordance elsewhere.
 *
 * Quantidade chip:
 *   - Hidden for `× 1` (no signal value; would just add noise to the
 *     common single-quantidade gift case).
 *   - Shown for `× 2` and above as a small mono chip — operator scans
 *     "this slot has 5 exemplars sold in one cart" at a glance.
 *
 * Layout: a single grid with three trailing tabular-nums columns so the
 * values right-align cleanly across rows even when the contribuição
 * names have wildly different lengths.
 */
function ItensList({ items }: { items: ReadonlyArray<ItemDTO> }) {
  return (
    <div className="border-t border-line pt-4">
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
        itens do carrinho
      </p>
      <ul className="divide-y divide-line/70 overflow-hidden rounded border border-line bg-cream-2/30">
        {items.map((item) => (
          <li key={item.id}>
            {item.tipo === "contribuicao" ? (
              <ItemContribuicaoRow item={item} />
            ) : (
              <ItemSurchargeRow item={item} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemContribuicaoRow({ item }: { item: ItemContribuicaoDTO }) {
  const shortId = `${item.idContribuicao.slice(0, 8)}…`;
  // Pre-0016 had no quantidade concept (every item was implicitly × 1);
  // suppress the chip for that common case to keep the row visually
  // calm. Multi-quantidade items get an explicit chip — that IS the
  // multi-item story Phase 4 is surfacing.
  const showQuantidadeChip = item.quantidade > 1;
  return (
    <div className="grid grid-cols-[1fr_max-content_max-content_max-content] items-baseline gap-x-4 gap-y-1 px-3 py-2 sm:gap-x-6">
      <div className="min-w-0 flex-col">
        <div className="flex flex-wrap items-baseline gap-2">
          {item.contribuicaoNome === null ? (
            <span
              className="truncate text-[13px] italic text-ink-mute"
              title={item.idContribuicao}
            >
              (contribuição removida — {shortId})
            </span>
          ) : (
            <span
              className="truncate text-[13px] text-ink"
              title={item.contribuicaoNome}
            >
              {item.contribuicaoNome}
            </span>
          )}
          {showQuantidadeChip && (
            <span className="inline-flex shrink-0 items-center rounded border border-line bg-paper px-1.5 py-[1px] font-mono text-[10px] uppercase tracking-[0.12em] text-ink-soft">
              × <span className="tabular-nums">{item.quantidade}</span>
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          contribuição
        </span>
      </div>
      <ItemValueColumn
        label="contribuição"
        cents={item.lineContributionAmountCents}
        emphasis
      />
      <ItemValueColumn label="taxa" cents={item.lineFeeAmountCents} />
      <ItemValueColumn
        label="recebedor"
        cents={item.lineReceiverAmountCents}
      />
    </div>
  );
}

function ItemSurchargeRow({ item }: { item: ItemSurchargeDTO }) {
  // Surcharge sits visually distinct — italic + softer label — because
  // it's a cart-wide passthrough rather than a per-slot line. The
  // operator scans the contribuição rows first; the surcharge tail-row
  // reads as "and then there's the cart fee." No per-line composição
  // columns: surcharge has no contribution/receiver split — the whole
  // amount goes to Stripe.
  return (
    <div className="grid grid-cols-[1fr_max-content] items-baseline gap-x-4 gap-y-1 bg-cream-2/40 px-3 py-2 sm:gap-x-6">
      <div className="flex flex-col">
        <span className="text-[13px] italic text-ink-soft">
          taxa de processamento — cartão
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-mute">
          passthrough · cart-wide
        </span>
      </div>
      <ItemValueColumn label="acréscimo" cents={item.amountCents} emphasis />
    </div>
  );
}

function ItemValueColumn({
  label,
  cents,
  emphasis = false,
}: {
  label: string;
  cents: number;
  emphasis?: boolean;
}) {
  return (
    <div className="flex flex-col items-end">
      <span
        className={[
          "font-mono tabular-nums",
          emphasis ? "text-[13px] text-ink" : "text-[12px] text-ink-soft",
        ].join(" ")}
      >
        {formatBRL(cents)}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-mute">
        {label}
      </span>
    </div>
  );
}

/**
 * ComposicaoAgregadaTable — Plan 0016 Phase 4 (aperture-3htxg).
 *
 * The cart totals — sum across items of each per-line component. Same
 * structured grid as the pre-0016 composição table, swapped to the
 * aggregate field names. The book-balance triple
 * (`contribuição + taxa + surcharge = total`) reads at a glance from
 * the row order; the recebedor net follows below as the "what the
 * gift recipient actually gets" payoff line.
 */
function ComposicaoAgregadaTable({
  agregada,
}: {
  agregada: ComposicaoAggregateDTO;
}) {
  const rows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "Total contribuição",
      value: <BrlValue cents={agregada.totalContributionCents} />,
    },
    {
      label: "Total taxa plataforma",
      value: <BrlValue cents={agregada.totalFeeCents} />,
    },
    {
      label: "Total acréscimo cartão",
      value: <BrlValue cents={agregada.totalSurchargeCents} />,
    },
    {
      label: "Total pago",
      value: <BrlValue cents={agregada.totalPaidCents} emphasis />,
    },
    {
      label: "Líquido ao recebedor",
      value: <BrlValue cents={agregada.totalReceiverCents} />,
    },
    {
      label: "Responsável pela taxa",
      value: (
        <span className="text-[13px] text-ink">{agregada.responsavelTaxa}</span>
      ),
    },
  ];
  return (
    <div className="border-t border-line pt-4">
      <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
        composição agregada
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

type ChipPalette = {
  border: string;
  bg: string;
  text: string;
  dot: string;
  label: string;
};

const STATUS_PALETTE: Record<PagamentoStatus, ChipPalette> = {
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
};

// Liberacao overlay (aperture-mjgxe). Applies only when status='aprovado'.
// 'disponivel' inherits the aprovado emerald (same hue family — settled
// success state). 'aguardando_liberacao' uses a DEEPER amber than
// processing's so both "waiting" chips read as the same family without
// visually colliding.
const LIBERACAO_PALETTE: Record<"aguardando_liberacao" | "disponivel", ChipPalette> = {
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

/**
 * 5-state StatusPill + 2-substate liberacao overlay per plan 0015.
 *
 * Status-level palette (Phase 6 / Locked Decision #7):
 *
 *   pendente    → zinc     (created, no Stripe motion)
 *   processing  → amber    (in-flight; pix QR scanned / ACH float — light amber)
 *   aprovado    → emerald  (success — money received from Stripe)
 *   rejeitado   → red      (failed before/during processing)
 *   estornado   → stone    (refunded after aprovado — muted past-tense)
 *
 * Liberacao overlay (aperture-mjgxe — applies ONLY when status='aprovado'):
 *
 *   liberacao=null              → falls back to status-level palette
 *                                 (i.e. for non-aprovado pagamentos)
 *   liberacao='disponivel'      → emerald (same hue as aprovado), label
 *                                 changes to "disponível". The pagamento has
 *                                 settled and is ready for transfer.
 *   liberacao='aguardando_lib…' → amber-100 / amber-700 — a DARKER amber than
 *                                 processing's amber-50 / amber-500. Both
 *                                 sub-states sit in the "waiting" family but
 *                                 visually distinct: processing reads as
 *                                 ACTIVE in-flight motion, aguardando_libera-
 *                                 cao reads as PASSIVE waiting on an external
 *                                 maturation timer (Stripe T+1 / D+30).
 *
 * Why deeper amber for aguardando_liberacao rather than emerald-outline:
 *   - The operator's mental model is "this isn't fully settled yet" — the
 *     chip should NOT read as "ready" (which emerald does, even outlined).
 *   - Two waiting states in the same hue family creates a learnable visual
 *     vocabulary: "amber = waiting; processing amber = active wait; aguar-
 *     dando amber = passive wait". The bg-weight delta (50 → 100) + text-
 *     weight delta (800 → 700) keeps them distinct at a glance.
 *
 * All chips share the same shape, padding, and `size-[6px]` dot — only the
 * color band and label differ. No layout change.
 */
function StatusPill({
  status,
  liberacao,
}: {
  status: PagamentoStatus;
  liberacao: LiberacaoState;
}) {
  // When liberacao is set, it overrides the status-level palette + label.
  // Only happens when status='aprovado' (Rex's backend derives null for
  // every other status), so the override always sits on top of the
  // emerald base — we just substitute palette + label.
  const palette =
    liberacao !== null
      ? LIBERACAO_PALETTE[liberacao]
      : STATUS_PALETTE[status];
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
