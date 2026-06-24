import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  FILTER_OPTIONS,
  fmtMoney,
  dateLong,
  dateShort,
  STATUS_TINT,
  type PresentesStatus,
  type PresentesTx,
} from "@/lib/mocks/presentes";
import {
  ACCOUNT_TYPES,
  BANKS,
  PIX_TYPES,
  bankByCode,
  type BancariosForm as BancariosFormState,
  type BancariosMode,
  type PixType,
} from "@/lib/mocks/bancarios";
import { trpc } from "@/lib/trpc";
// aperture-jtamj — local PIX-key-type tuple (used to be inferred from the
// pre-swap CriarRecebedorInputSchema discriminated union; Rex's flat wire
// landed with the same string set so we keep the same vocabulary).
type PixKeyTipo = "cpf" | "cnpj" | "email" | "telefone" | "aleatoria";
import {
  type ExtratoLiberacao,
  type ExtratoRowDTO,
  type ExtratoSummaryDTO,
  type SolicitarTransferenciaState,
  useStubCampanhaIdForSlug,
  useStubExtratoList,
  useStubExtratoSummary,
  useStubSolicitarTransferencia,
} from "./ExtratoStubData";

// aperture-xjwc — "Presentes recebidos" (extrato + resgatar).
//
// A cream paper "ticket sheet" (washi tape, scalloped bottom edge, paper noise)
// holding: a summary header (RECEBIDO / RESGATADO + a full-width DISPONÍVEL
// block with yellow marca-texto), a single green "solicitar transferência"
// CTA inside the sheet (aperture-fxfbk collapsed the previous dual CTA pair
// — both buttons opened the same transfer modal), aux pills, a status filter
// popover, and the status-tinted ticket rows. Clicking a row opens a detail
// drawer; the resgatado summary opens a wide modal; the CTA opens the
// transfer modal. All interactivity is local React state — mock-first, no
// fetch/auth/backend. Faithful port of the design export (statement.jsx +
// decorations.jsx + app.jsx + styles.css).
//
// The export's scrapbook recipe lives in non-token vars (--sheet-*) that don't
// exist in the global tailwind.css, so the whole visual recipe is scoped under
// `.presentes-extrato` in a component-local <style> block. The brand tokens
// (--lilac*, --plum, --green*, --yellow, --coral-pink, fonts) come from the
// app shell, and the green CTA uses --green-deep per the Sistema de Design
// reservation (green = "resgatar / receber valores").

/**
 * Plan q2d4b Track 4 — recebedor extrato wiring (aperture-ekn90).
 *
 * Pre-wire: this surface consumed `PRESENTES_TX` + `summarize()` from the
 * painelDemo mock. Post-wire: drives off Rex's locked
 * `recebedor.extrato.{summary,list}` + `recebedor.transferencia.solicitar`
 * procs (aperture-7g5sx Track 2 backend).
 *
 * §9 parallel-prep stubs ship in ./ExtratoStubData.ts — hook bodies swap to
 * trpc.useQuery / useMutation when Rex's PR lands; consumers unchanged.
 *
 * Wire-shape mapping (extrato wire → existing visual layer):
 *
 *   ExtratoSummaryDTO        →  PresentesSummary subset
 *   ├ totalRecebidoCents     →  summary.recebido
 *   ├ totalPresentes         →  summary.presentes
 *   ├ resgatadoCents         →  summary.resgatado (+ aguardandoAprovacaoCents, aperture-eqdxl)
 *   ├ saldoDisponivelCents   →  summary.disponivel
 *   ├ aguardandoLiberacaoCents → summary.aguardando
 *   ├ aguardandoAprovacaoCents → summary.aguardandoAprovacao (aperture-1ut92)
 *   ├ proximaTransfDate      →  NEXT_TRANSFER_LABEL (computed pt-BR)
 *   └ dateRangeStart/End     →  EVENT_PERIOD (computed pt-BR)
 *
 *   ExtratoRowDTO            →  PresentesTx (in-row, 5-state liberacao —
 *                               wire ships lancamento grain; "out" events
 *                               from the mock are gone, surfaced via
 *                               summary totals + the solicitar mutation)
 *   ├ idLancamento           →  tx.id
 *   ├ timestamp (ISO)        →  tx.d + tx.t
 *   ├ contribuinteNome | null →  tx.guest  (default: "(anônimo)")
 *   ├ amountCents            →  tx.amount
 *   ├ liberacao 4-state      →  tx.status  (mapped via LIBERACAO_TO_STATUS)
 *   └ liberacaoPrevistaEm             →  surfaced via DetailDrawer when applicable
 *
 *   (Gift name + per-row metodo NOT on wire — Rex's projection is
 *   deliberately lean. Mirrored from RepasseLancamentoDetail discipline.)
 *
 * Errors on solicitar (per Rex's confirmation):
 *   TRPCError code='CONFLICT'                + message='repasse_ja_pendente'
 *     → button disabled, label "transferência já solicitada"
 *   TRPCError code='UNPROCESSABLE_CONTENT'   + message='saldo_disponivel_insuficiente'
 *     → button disabled, label "sem saldo disponível"
 *   Other code='BAD_REQUEST'                  → generic error toast
 */

/** Pre-wire label fallbacks — used while data is loading. */
const EVENT_TITLE_FALLBACK = "extrato";
const EVENT_PERIOD_FALLBACK = "carregando…";
const NEXT_TRANSFER_FALLBACK = "—";

/** Wire-to-PresentesStatus mapping. aperture-1ut92 extended the wire to
 *  5 lancamento-grain liberacao states by adding 'solicitado' — the
 *  admin-pipeline state. The mock vocabulary already had a 'tSolicitada'
 *  status with a lilac/purple palette designed for exactly this shape,
 *  so the new mapping reuses it (aperture-yspfw confirms — no new
 *  visual treatment needed; the palette was waiting). */
const LIBERACAO_TO_STATUS: Record<ExtratoLiberacao, PresentesStatus> = {
  aguardando_liberacao: "aguardando",
  disponivel: "disponivel",
  solicitado: "tSolicitada",
  transferido: "tEnviada",
  cancelado: "estornado",
};

/**
 * Reverse of LIBERACAO_TO_STATUS — used when reverse-mapping a mock-status
 * chip filter to a wire-status filter. Returns null for `resgatado` — the
 * only remaining mock status without a wire equivalent (account-level
 * out-row concept that the wire's lancamento-grain projection doesn't
 * model). aperture-1ut92 added 'solicitado' to the wire, so tSolicitada
 * now has a clean reverse mapping (it surfaces as an in-row state again).
 *
 * Currently UNUSED (the page filters client-side instead of pushing
 * statusFilters to the wire) but kept for the eventual swap-time pivot to
 * server-side filtering.
 */
// @ts-expect-error — reserved for the future swap to server-side filter.
function _mockToLiberacao(s: PresentesStatus): ExtratoLiberacao | null {
  switch (s) {
    case "aguardando":
      return "aguardando_liberacao";
    case "disponivel":
      return "disponivel";
    case "tSolicitada":
      return "solicitado";
    case "tEnviada":
      return "transferido";
    case "estornado":
      return "cancelado";
    case "resgatado":
      return null;
  }
}

// ── Wire → mock adapters ────────────────────────────────────────────────────

interface PresentesSummaryUI {
  recebido: number;
  presentes: number;
  resgatado: number;
  disponivel: number;
  aguardando: number;
  /** Sum of solicitado lançamentos — money in the admin-approval queue
   *  (aperture-1ut92). Surfaced as a dedicated aux pill in the summary
   *  block so the operator sees all three liquidity buckets honestly:
   *  saldoDisponivel (actionable) · aguardandoAprovacao (admin queue) ·
   *  aguardandoLiberacao (Stripe maturação). */
  aguardandoAprovacao: number;
  opening: number;
}

function adaptSummary(s: ExtratoSummaryDTO): PresentesSummaryUI {
  return {
    recebido: s.totalRecebidoCents,
    presentes: s.totalPresentes,
    // aperture-eqdxl — the RESGATADO figure sums TWO buckets: already
    // transferred (resgatadoCents) PLUS in-flight admin-approval
    // (aguardandoAprovacaoCents). Both are money the user has already
    // SOLICITAR'd out of their disponível balance — from the operator's
    // mental model it's "resgatado" the moment a transfer is requested,
    // not only once admin approves. These are disjoint backend buckets
    // (transferidoEm IS NOT NULL vs solicitado-but-not-transferred), so
    // summing them does NOT double-count. The dedicated "aguardando
    // aprovação" aux pill below still surfaces the in-flight slice
    // separately as a breakdown.
    resgatado: s.resgatadoCents + (s.aguardandoAprovacaoCents ?? 0),
    disponivel: s.saldoDisponivelCents,
    aguardando: s.aguardandoLiberacaoCents,
    // aperture-1ut92 — fall back to 0 for the trpc-cache-rotation window
    // (older cached summaries lack this bucket); once the cache rotates
    // the field is always populated by Rex's server-side aggregation.
    aguardandoAprovacao: s.aguardandoAprovacaoCents ?? 0,
    // `opening` is a mock concept (account-level prior balance carried
    // forward) that doesn't exist on Rex's wire. The wire saldoDisponivel
    // already accounts for all activity — no rolling prior balance needed.
    // Zeroed here for shape compat.
    opening: 0,
  };
}

function adaptRow(row: ExtratoRowDTO): PresentesTx {
  // Split ISO timestamp into date + time of day for the mock-shaped row.
  // YYYY-MM-DDTHH:MM:SSZ → ('YYYY-MM-DD', 'HH:MM')
  const isoSafe = row.timestamp.length >= 16 ? row.timestamp : row.timestamp + "T00:00:00";
  const d = isoSafe.slice(0, 10);
  const t = isoSafe.slice(11, 16);
  return {
    id: row.idLancamento,
    d,
    t,
    type: "in",
    guest: row.contribuinteNome ?? "(anônimo)",
    // aperture-k6fbz — gift name now projected on the wire (Rex backend
    // merged at ed459fd). Defensive `||` covers BOTH the optional-absence
    // case (cached response from before the merge) AND the empty-string
    // case (contribuição deleted between pagamento + read). Falls back to
    // the pre-k6fbz "lançamento" generic label so the row stays readable.
    item: row.contribuicaoNome || "lançamento",
    note: "",
    amount: row.amountCents,
    status: LIBERACAO_TO_STATUS[row.liberacao],
    // aperture-m58zm — populated only when liberacao='aguardando_liberacao'
    // AND parent pagamento has balanceTransactionAvailableOn. Drives the
    // drawer's "libera em DD/MM/YYYY" sub-label; null state renders an
    // "aguardando confirmação do pagamento" fallback.
    liberacaoPrevistaEm: row.liberacaoPrevistaEm,
    // aperture-k6fbz — gift image projection. Wire may carry an emoji
    // glyph ("🍼") OR a hosted URL ("https://…"). The renderer
    // discriminates by URL shape: starts-with-`http` or `/` → <img>,
    // else → text glyph. Null/absent → no thumbnail.
    itemImagemUrl: row.contribuicaoImagemUrl ?? null,
    // aperture-qp4mq — per-item quantidade. Drives the "× N" suffix
    // on the drawer's item row when > 1; the row itself shows only
    // the item name (the badge would crowd the inline two-line ticket).
    quantidade: row.quantidade,
  };
}

// ── Header label formatters ─────────────────────────────────────────────────

const MES_ABREV = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

const WEEKDAY_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function formatEventPeriod(
  startIso: string | null,
  endIso: string | null,
): string {
  if (startIso === null || endIso === null) return EVENT_PERIOD_FALLBACK;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return EVENT_PERIOD_FALLBACK;
  }
  const sd = String(start.getDate()).padStart(2, "0");
  const sm = MES_ABREV[start.getMonth()];
  const ed = String(end.getDate()).padStart(2, "0");
  const em = MES_ABREV[end.getMonth()];
  const yr = end.getFullYear();
  return `${sd}/${sm} — ${ed}/${em} · ${yr}`;
}

function formatNextTransferLabel(iso: string | null): string {
  if (iso === null) return NEXT_TRANSFER_FALLBACK;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NEXT_TRANSFER_FALLBACK;
  const wd = WEEKDAY_PT[d.getDay()];
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = MES_ABREV[d.getMonth()];
  return `${wd} · ${dd}/${mm}`;
}

/**
 * Aguardando-state drawer "previsão" copy. Replaces the pre-wire hardcoded
 * "libera em até 72h" (aperture-m58zm).
 *
 * Wire shape: `t.liberacaoPrevistaEm` is ISO when liberacao=aguardando_liberacao
 * AND parent pagamento has balanceTransactionAvailableOn. Null when the
 * webhook dispatcher hasn't yet persisted available_on (orphan window)
 * OR for any state other than aguardando — but the drawer guard
 * (`t.status === "aguardando"`) already gates non-aguardando out.
 *
 * Output:
 *   - liberacaoPrevistaEm known → "libera em DD/MM/YYYY"
 *   - liberacaoPrevistaEm null  → "aguardando confirmação do pagamento"
 *
 * The concrete-date format beats relative ("em X dias") because operators
 * are planning around a real settlement date — they want a date they can
 * write down, not a moving rolling label.
 */
function formatAguardandoPrevisao(liberacaoPrevistaEm: string | null): string {
  if (liberacaoPrevistaEm === null) return "aguardando confirmação do pagamento";
  const d = new Date(liberacaoPrevistaEm);
  if (Number.isNaN(d.getTime())) return "aguardando confirmação do pagamento";
  try {
    const formatted = d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    return `libera em ${formatted}`;
  } catch {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `libera em ${dd}/${mm}/${yyyy}`;
  }
}

// ── Loading / error / empty surfaces ────────────────────────────────────────

function ExtratoLoadingState() {
  return (
    <section
      className="presentes-extrato"
      style={{ padding: "32px 16px", textAlign: "center" }}
    >
      <p
        className="ex-mono"
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "11px",
          textTransform: "uppercase",
          letterSpacing: "0.18em",
          color: "var(--ink-mute, #999)",
        }}
      >
        carregando extrato…
      </p>
    </section>
  );
}

function ExtratoErrorState({ message }: { message: string }) {
  return (
    <section
      className="presentes-extrato"
      style={{ padding: "32px 16px", maxWidth: 640, margin: "0 auto" }}
    >
      <div
        role="alert"
        style={{
          padding: "14px 18px",
          borderRadius: 10,
          background: "#F4D6CE",
          color: "#7B2A1A",
          textAlign: "center",
        }}
      >
        <p
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "11px",
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            margin: 0,
          }}
        >
          erro ao carregar extrato
        </p>
        <p style={{ marginTop: 6, fontSize: "13px" }}>{message}</p>
      </div>
    </section>
  );
}

function IconArrowUpRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

function IconFilter() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 3H2l8 9.5V20l4 2v-9.5z" />
    </svg>
  );
}

// ── Filter popover ───────────────────────────────────────────────────────────
function FilterButton({
  active,
  counts,
  onChange,
}: {
  active: PresentesStatus[];
  counts: Partial<Record<PresentesStatus, number>>;
  onChange: (next: PresentesStatus[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // aperture-sm7uc (#8) — pop-coords for the portalled panel.
  // The parent `.ex-sheet` uses CSS `mask` which creates a clipping
  // stacking context: any in-tree absolute child that crosses the
  // mask boundary gets painted into nothing, which made the panel
  // disappear behind the ticket rows below. Portalling to <body>
  // with position: fixed sidesteps the mask entirely.
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setCoords({
        top: r.bottom + 6,
        right: Math.max(8, window.innerWidth - r.right),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [open]);

  const toggle = (k: PresentesStatus) => {
    onChange(active.includes(k) ? active.filter((x) => x !== k) : [...active, k]);
  };

  return (
    <div className="ex-filter">
      <button
        ref={btnRef}
        type="button"
        className={`ex-filter-btn ${open ? "is-open " : ""}${active.length ? "is-active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <IconFilter />
        filtrar status
        {active.length > 0 && <span className="ex-filter-badge">{active.length}</span>}
      </button>

      {open && coords !== null && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            className="ex-filter-panel presentes-extrato-portal"
            role="menu"
            style={{
              position: "fixed",
              top: coords.top,
              right: coords.right,
              zIndex: 120,
            }}
          >
            <div className="ex-filter-panel-hd">
              <span className="ex-caps">por status</span>
              {active.length > 0 && (
                <button type="button" className="ex-link" onClick={() => onChange([])}>
                  limpar
                </button>
              )}
            </div>
            <div className="ex-filter-pills">
              {FILTER_OPTIONS.map((o) => {
                const on = active.includes(o.key);
                return (
                  <button
                    key={o.key}
                    type="button"
                    className={`ex-filter-pill ${on ? "is-on" : ""}`}
                    style={on ? { background: `${o.color}22`, borderColor: o.color, color: o.color } : undefined}
                    onClick={() => toggle(o.key)}
                  >
                    <i className="ex-filter-dot" style={{ background: o.color }} />
                    {o.label}
                    <span className="ex-filter-count">{counts[o.key] || 0}</span>
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ── Gift thumbnail ─────────────────────────────────────────────────────────
/**
 * Renders the contribuição's image next to the row item label
 * (aperture-k6fbz). The wire field carries EITHER:
 *   - a short emoji glyph (e.g. "🍼", "🧸") → rendered as text
 *   - a hosted URL ("https://…" or "/path") → rendered as <img>
 *
 * URL detection: starts-with `http` or `/`. Anything else is treated
 * as a text glyph (covers raw emoji + any short-string fallback the
 * backend may surface). Null/empty → renders nothing so the row falls
 * back to the label-only layout.
 *
 * Width is fixed at 28px so rows with + without an image stay aligned;
 * the wrap container's `gap` handles spacing without needing per-row
 * conditionals. Image is loaded `lazy` (offscreen rows don't fetch).
 */
function GiftThumb({ url }: { url: string | null }) {
  if (!url) return null;
  const isHostedUrl = url.startsWith("http") || url.startsWith("/");
  return (
    <span className="ex-t-thumb" aria-hidden>
      {isHostedUrl ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          width={28}
          height={28}
        />
      ) : (
        <span className="ex-t-thumb-glyph">{url}</span>
      )}
    </span>
  );
}

// ── Ticket row ─────────────────────────────────────────────────────────────
function TicketRow({ tx, onPick }: { tx: PresentesTx; onPick: (tx: PresentesTx) => void }) {
  const tint = STATUS_TINT[tx.status];
  const isIn = tx.type === "in";
  const isReversed = tx.status === "estornado";
  return (
    <li
      className={`ex-trow ${isReversed ? "is-reversed " : ""}t-${tx.status}`}
      style={
        {
          "--tint-bg": tint.bg,
          "--tint-stripe": tint.stripe,
          "--tint-ink": tint.ink,
        } as React.CSSProperties
      }
      onClick={() => onPick(tx)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick(tx)}
    >
      <span className="ex-t-stripe" />
      <div className="ex-t-body">
        <div className="ex-t-l1">
          <span className="ex-t-item-wrap">
            <GiftThumb url={tx.itemImagemUrl ?? null} />
            <span className="ex-t-item">{tx.item}</span>
          </span>
          <span className={`ex-t-val ${isIn ? "pos" : "neg"}${isReversed ? " reversed" : ""}`}>
            {isIn ? "+" : "−"} {fmtMoney(tx.amount)}
          </span>
        </div>
        <div className="ex-t-l2">
          <span className="ex-t-from">
            <span className="ex-t-prep">{isIn ? "de" : "para"}</span> <strong>{tx.guest}</strong>
          </span>
          <span className="ex-t-meta">
            <span className="ex-t-status ex-mono">{tint.label}</span>
            <span className="ex-t-dot">·</span>
            {/* aperture-958vo — status line shows DATE ONLY. The `· <time>`
                suffix was dropped per operator request (applies to every
                state: transferido/disponível/etc). `tx.t` is still parsed
                from the wire timestamp for other surfaces, just not shown
                here. */}
            <span className="ex-t-date ex-mono">{dateShort(tx.d)}</span>
          </span>
        </div>
      </div>
    </li>
  );
}

// ── Detail drawer ────────────────────────────────────────────────────────────
function DetailDrawer({ tx, onClose }: { tx: PresentesTx | null; onClose: () => void }) {
  const [shown, setShown] = useState<PresentesTx | null>(null);
  useEffect(() => {
    if (tx) setShown(tx);
  }, [tx]);

  const open = !!tx;
  const t = shown;
  if (!t) return null;

  const tint = STATUS_TINT[t.status];
  const isIn = t.type === "in";
  const firstName = (t.guest || "").split(/[ ·]/)[0];

  return (
    <>
      <div className={`ex-scrim ${open ? "is-open" : ""}`} onClick={onClose} />
      <aside className={`ex-drawer ${open ? "is-open" : ""}`} role="dialog" aria-label="Detalhes">
        <header className="ex-drawer-hd">
          <span className="ex-caps">{isIn ? "presente recebido" : "movimento de saída"}</span>
          <button type="button" className="ex-icon-btn" onClick={onClose} aria-label="Fechar">
            <IconClose />
          </button>
        </header>

        <div className="ex-drawer-amount">
          <span className={`ex-drawer-sign ${isIn ? "" : "out"}`}>{isIn ? "+" : "−"}</span>
          <span className="ex-drawer-currency">R$</span>
          <span className="ex-drawer-num">{fmtMoney(t.amount).replace("R$", "").trim()}</span>
        </div>

        <div className="ex-drawer-status" style={{ background: tint.bg, color: tint.ink, borderColor: tint.stripe }}>
          <i className="ex-dot" style={{ background: tint.stripe }} />
          <span>{tint.label}</span>
        </div>

        <dl className="ex-drawer-meta">
          <div>
            <dt>item</dt>
            <dd className="ex-drawer-item-dd">
              <GiftThumb url={t.itemImagemUrl ?? null} />
              <span>
                {t.item}
                {typeof t.quantidade === "number" && t.quantidade > 1 && (
                  <span
                    aria-label={`quantidade ${t.quantidade}`}
                    style={{
                      marginLeft: 8,
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--ink-soft)",
                      fontWeight: 600,
                    }}
                  >
                    × {t.quantidade}
                  </span>
                )}
              </span>
            </dd>
          </div>
          {t.note && (
            <div>
              <dt>observação</dt>
              <dd>{t.note}</dd>
            </div>
          )}
          <div>
            <dt>{isIn ? "convidado" : "destino"}</dt>
            <dd>{t.guest}</dd>
          </div>
          <div>
            <dt>data</dt>
            <dd>{dateLong(t.d)}</dd>
          </div>
          {/* aperture-qp4mq — IDENTIFICADOR row removed (internal UUID,
              not user-actionable). The id stays available on the underlying
              tx for support / debugging purposes but no longer renders in
              the drawer surface. */}
          {t.status === "tSolicitada" && (
            <div>
              <dt>previsão</dt>
              <dd>próximo dia útil</dd>
            </div>
          )}
          {t.status === "aguardando" && (
            <div>
              <dt>previsão</dt>
              <dd>{formatAguardandoPrevisao(t.liberacaoPrevistaEm ?? null)}</dd>
            </div>
          )}
          {t.status === "estornado" && (
            <div>
              <dt>motivo</dt>
              <dd>pagamento estornado pelo provedor</dd>
            </div>
          )}
        </dl>

        <div className="ex-drawer-actions">
          {/* aperture-h8sd5 — hide "enviar agradecimento" ONLY when the gift
              is already transferido (wire 'transferido' → UI status
              "tEnviada"). It MUST still show on every other state, including
              disponível ("disponivel") and aguardando liberação
              ("aguardando"). The pre-existing estornado guard stays (no
              thank-you on a reversed payment). */}
          {isIn && t.status !== "estornado" && t.status !== "tEnviada" && (
            <button type="button" className="ex-btn-primary block" onClick={onClose}>
              enviar agradecimento à {firstName}
            </button>
          )}
          {/* aperture-qp4mq — BAIXAR COMPROVANTE button removed. No PDF
              download in scope; the IconDownload import was kept dead-code
              free by removing both the button + its handler. If a receipt
              feature returns, file a fresh bead with the storage shape +
              user trigger. */}
        </div>
      </aside>
    </>
  );
}

// ── Transfer modal ───────────────────────────────────────────────────────────
//
// aperture-sm7uc (#9) — all-or-nothing confirm modal. The previous
// version embedded an amount <input> + "usar tudo" + a mocked destination
// summary, both of which encouraged a partial-withdrawal mental model
// that the backend never supported (Rex's solicitarRepasseRecebedor
// sweeps the WHOLE saldo per locked decision aperture-s03dr). The new
// shape is a plain confirm: "Transferir R$ X (tudo) — confirmar?"
// followed by a single solicit button. No amount input ever, no
// destination override.
//
// aperture-kbmel (#9 deferred path) — when hasRecebedor === false, the
// modal body becomes a slim BancariosBody form (Conta Completa / Chave Pix
// tabs, titular guard, locked CPF from session). On submit the modal
// chains: useCriarRecebedor.mutate() → on success →
// solicitarState.mutate() → close. Both branches share the same modal
// chrome (header / scrim / close button); only the body swaps.
function TransferModal({
  open,
  saldo,
  hasRecebedor,
  idCampanha,
  onClose,
  solicitarState,
}: {
  open: boolean;
  saldo: number;
  /** Drives the onboarding branch. Sourced from useStubCampanhaIdForSlug. */
  hasRecebedor: boolean;
  /** Required to submit recebedor.criar (the input schema demands it). */
  idCampanha: string | null;
  onClose: () => void;
  solicitarState: SolicitarTransferenciaState;
}) {
  if (!open) return null;

  // Branch on hasRecebedor. Existing-recebedor flow keeps the current
  // all-or-nothing confirm body verbatim; no-recebedor flow embeds the
  // onboarding form.
  if (!hasRecebedor) {
    return (
      <TransferOnboardingModal
        saldo={saldo}
        idCampanha={idCampanha}
        onClose={onClose}
        solicitarState={solicitarState}
      />
    );
  }

  const submit = () => {
    if (solicitarState.isPending) return;
    solicitarState.mutate();
  };

  // Discriminate domain errors per Rex's locked contract.
  // - CONFLICT + 'repasse_ja_pendente'         → "transferência já solicitada"
  // - UNPROCESSABLE_CONTENT + 'saldo_…insuficiente' → "sem saldo disponível"
  // - else                                    → generic message
  const errorLabel = solicitarState.error
    ? formatSolicitarError(solicitarState.error)
    : null;
  const isBlocking =
    errorLabel === "transferência já solicitada" ||
    errorLabel === "sem saldo disponível";

  return (
    <>
      <div className="ex-scrim is-open" onClick={onClose} />
      <div className="ex-modal" role="dialog" aria-label="Solicitar transferência">
        <header className="ex-modal-hd">
          <div>
            <span className="ex-caps">solicitar transferência</span>
            <h3 className="ex-modal-title">transferir tudo?</h3>
          </div>
          <button type="button" className="ex-icon-btn" onClick={onClose} aria-label="Fechar">
            <IconClose />
          </button>
        </header>
        <p className="ex-modal-text">
          vamos transferir <strong>{fmtMoney(saldo)} (tudo)</strong> para sua conta
          cadastrada. o valor cai em <strong>até 1 dia útil</strong> depois
          que aprovamos a solicitação por aqui.
        </p>
        <div
          className="ex-confirm-amount"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            padding: "18px 16px",
            margin: "0 0 22px",
            background: "var(--cream)",
            border: "1px dashed var(--line)",
            borderRadius: 12,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink-mute)",
            }}
          >
            total a transferir
          </span>
          <span
            style={{
              fontFamily: "var(--hand)",
              fontSize: 36,
              lineHeight: 1,
              color: "var(--plum)",
              fontFeatureSettings: '"tnum"',
            }}
          >
            {fmtMoney(saldo)}
          </span>
        </div>
        {errorLabel && (
          <div
            role="alert"
            className="ex-modal-error"
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              background: "#F4D6CE",
              color: "#7B2A1A",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "11px",
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              marginBottom: 14,
            }}
          >
            {errorLabel}
          </div>
        )}
        <div className="ex-modal-actions">
          <button
            type="button"
            className="ex-btn-ghost"
            onClick={onClose}
            disabled={solicitarState.isPending}
          >
            cancelar
          </button>
          <button
            type="button"
            className="ex-btn-green"
            onClick={submit}
            disabled={solicitarState.isPending || isBlocking || saldo === 0}
            aria-busy={solicitarState.isPending}
          >
            {solicitarState.isPending
              ? "solicitando…"
              : isBlocking
                ? errorLabel
                : "confirmar transferência"}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Transfer onboarding modal (no-recebedor path) ────────────────────────────
//
// aperture-kbmel — modal body when the user hits SOLICITAR TRANSFERÊNCIA
// without a recebedor configured. Slim port of BancariosBody form shape:
// Conta Completa / Chave Pix tabs, titular guard, CPF locked from session.
//
// On submit:
//   1. useCriarRecebedor.mutateAsync({ idCampanha, dadosBancarios, titular })
//   2. on success → solicitarState.mutate() (sweeps the saldo)
//   3. solicitarState.onSuccess in the parent closes the modal + toasts
//
// Embedded copy (not extracted) per the kbmel spec's "Simpler" option —
// the full BancariosBody is 35KB with its own CSS recipe, and embedding it
// 1:1 into a modal frame would require a significant CSS reshape. The
// slim port below mirrors the same form FIELDS + the same validation
// contract but uses inline modal-scoped styles. When/if a real form-
// extraction PR ships (kbmel spec's "Better" option), this whole
// component swaps to `<BancariosForm onSubmit={...} />`.
//
// TODO(aperture-kbmel-rex-swap): nothing in this component needs to change
// when Rex's backend lands — the swap point is `useCriarRecebedor` itself
// (see pages/lib/hooks/useCriarRecebedor.ts).
// aperture-chamy — empty seed for the onboarding transfer form (replaces the
// Thacyane BANCARIOS_DEMO mock prefill). tipoConta defaults to "cc".
const EMPTY_BANCARIOS_FORM: BancariosFormState = {
  bankCode: "",
  agencia: "",
  agenciaDV: "",
  conta: "",
  contaDV: "",
  tipoConta: "cc",
  pixKey: "",
  nome: "",
  telefone: "",
};

function TransferOnboardingModal({
  saldo,
  idCampanha,
  onClose,
  solicitarState,
}: {
  saldo: number;
  idCampanha: string | null;
  onClose: () => void;
  solicitarState: SolicitarTransferenciaState;
}) {
  // aperture-chamy — start empty (no Thacyane mock prefill). aperture-llnqc
  // parity: default to the PIX tab.
  const [s, setS] = useState<BancariosFormState>({ ...EMPTY_BANCARIOS_FORM });
  const [modo, setModo] = useState<BancariosMode>("pix");
  const [tipoPix, setTipoPix] = useState<PixType["v"]>("cpf");
  const [validationError, setValidationError] = useState<string | null>(null);

  // aperture-jtamj — real trpc.recebedor.criar mutation (Rex's #193 Phase A).
  // onSuccess invalidates auth.me so hasRecebedor flips true → next click
  // on SOLICITAR routes to the confirm-amount modal (existing B2 #188 path).
  const utils = trpc.useUtils();
  const criarRecebedor = trpc.recebedor.criar.useMutation({
    onSuccess: () => {
      // Invalidate auth.me so the hasRecebedor signal refetches.
      void utils.auth.me.invalidate();
      // Chain into solicitar. The parent wires solicitarState.onSuccess
      // to close the modal + show the toast, so a single side-effect
      // terminates the whole flow.
      solicitarState.mutate();
    },
  });

  const set = (patch: Partial<BancariosFormState>) =>
    setS((prev) => ({ ...prev, ...patch }));

  // Slim client-side validation: just enough to block obvious garbage
  // before hitting the wire. The shared `CriarRecebedorInputSchema`
  // re-validates inside the mock hook (and will inside Rex's procedure
  // post-swap), so this is belt-and-suspenders rather than the source
  // of truth.
  const validate = (): string | null => {
    if (!s.nome || s.nome.trim().split(/\s+/).length < 2) {
      return "informe o nome completo do titular";
    }
    if (!/^\(\d{2}\) \d{4,5}-\d{4}$/.test(s.telefone)) {
      return "celular inválido — use o formato (DD) 9XXXX-XXXX";
    }
    if (modo === "conta") {
      if (!s.bankCode) return "escolha o banco";
      if (!s.agencia) return "informe a agência";
      if (!s.conta) return "informe a conta";
      if (!s.contaDV) return "informe o dígito da conta";
      return null;
    }
    if (!s.pixKey) return "informe a chave pix";
    return null;
  };

  const submit = () => {
    if (criarRecebedor.isPending || solicitarState.isPending) return;
    const err = validate();
    if (err) {
      setValidationError(err);
      return;
    }
    setValidationError(null);
    if (idCampanha === null) {
      setValidationError("aguardando dados da campanha — tente novamente em um instante");
      return;
    }
    // aperture-jtamj — Rex's wire is flat + PIX-only.
    // {idCampanha, dadosRecebedor: {nomeTitular, tipoChavePix, chavePix}}.
    // Conta Completa tab still renders for visual continuity (BancariosBody
    // pattern parity) but its submit is gated behind a modo === "conta"
    // early-return — operator hits a toast pointing them at the Chave Pix
    // tab. Backend will accept conta_completa in a future iteration; until
    // then the user-visible affordance is the PIX path.
    if (modo === "conta") {
      setValidationError(
        "no momento só aceitamos chave Pix — use a aba 'Chave Pix' acima",
      );
      return;
    }
    // Pix mapping: PIX_TYPES.v has `celular`; Rex's wire wants `telefone`.
    // Aliases otherwise (cpf / email / aleatoria) are identical.
    const tipoChavePix: "cpf" | "cnpj" | "email" | "telefone" | "aleatoria" =
      tipoPix === "celular" ? "telefone" : (tipoPix as PixKeyTipo);

    criarRecebedor.mutate({
      idCampanha,
      dadosRecebedor: {
        metodo: "pix",
        nomeTitular: s.nome.trim(),
        tipoChavePix,
        chavePix: s.pixKey,
      },
    });
  };

  const bank = bankByCode(s.bankCode);
  const tipo = PIX_TYPES.find((p) => p.v === tipoPix) ?? PIX_TYPES[0]!;
  const isBusy = criarRecebedor.isPending || solicitarState.isPending;

  const solicitarError = solicitarState.error
    ? formatSolicitarError(solicitarState.error)
    : null;
  const criarError = criarRecebedor.error
    ? "não foi possível cadastrar — confira os dados e tente de novo"
    : null;
  const inlineError = validationError ?? criarError ?? solicitarError;

  return (
    <>
      <div className="ex-scrim is-open" onClick={onClose} />
      <div
        className="ex-modal ex-modal-wide"
        role="dialog"
        aria-label="Cadastrar dados bancários para transferência"
      >
        <header className="ex-modal-hd">
          <div>
            <span className="ex-caps">solicitar transferência</span>
            <h3 className="ex-modal-title">cadastre sua conta</h3>
          </div>
          <button type="button" className="ex-icon-btn" onClick={onClose} aria-label="Fechar">
            <IconClose />
          </button>
        </header>
        <p className="ex-modal-text">
          pra transferir <strong>{fmtMoney(saldo)} (tudo)</strong> a gente
          precisa dos dados da sua conta — só dessa vez. depois é só clicar
          em "solicitar" e a transferência vai automática.
        </p>

        {/* Mode toggle: conta completa ↔ chave pix */}
        <div
          role="tablist"
          aria-label="forma de recebimento"
          style={{
            display: "flex",
            gap: 8,
            padding: 4,
            background: "var(--cream)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            margin: "0 0 14px",
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={modo === "conta"}
            onClick={() => setModo("conta")}
            style={tabStyle(modo === "conta")}
          >
            conta completa
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={modo === "pix"}
            onClick={() => setModo("pix")}
            style={tabStyle(modo === "pix")}
          >
            chave pix
          </button>
        </div>

        {/* Form body */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
          {modo === "conta" ? (
            <>
              <FieldRow label="banco" required>
                <select
                  className="ex-modal-input"
                  value={s.bankCode}
                  onChange={(e) => set({ bankCode: e.target.value })}
                  aria-label="banco"
                  style={inputStyle}
                >
                  {BANKS.map((b) => (
                    <option key={b.code} value={b.code}>
                      {b.name} ({b.code})
                    </option>
                  ))}
                </select>
                <span style={helperStyle}>{bank.name}</span>
              </FieldRow>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 80px", gap: 10 }}>
                <FieldRow label="agência" required>
                  <input
                    style={inputStyle}
                    inputMode="numeric"
                    maxLength={6}
                    value={s.agencia}
                    onChange={(e) => set({ agencia: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                    aria-label="agência"
                  />
                </FieldRow>
                <FieldRow label="dígito">
                  <input
                    style={inputStyle}
                    inputMode="numeric"
                    maxLength={2}
                    value={s.agenciaDV}
                    onChange={(e) => set({ agenciaDV: e.target.value.replace(/[^\dxX]/g, "").slice(0, 2) })}
                    aria-label="dígito da agência"
                  />
                </FieldRow>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 1fr", gap: 10 }}>
                <FieldRow label="conta" required>
                  <input
                    style={inputStyle}
                    inputMode="numeric"
                    maxLength={14}
                    value={s.conta}
                    onChange={(e) => set({ conta: e.target.value.replace(/\D/g, "").slice(0, 14) })}
                    aria-label="conta"
                  />
                </FieldRow>
                <FieldRow label="dígito" required>
                  <input
                    style={inputStyle}
                    inputMode="numeric"
                    maxLength={2}
                    value={s.contaDV}
                    onChange={(e) => set({ contaDV: e.target.value.replace(/[^\dxX]/g, "").slice(0, 2) })}
                    aria-label="dígito da conta"
                  />
                </FieldRow>
                <FieldRow label="tipo" required>
                  <select
                    style={inputStyle}
                    value={s.tipoConta}
                    onChange={(e) => set({ tipoConta: e.target.value })}
                    aria-label="tipo de conta"
                  >
                    {ACCOUNT_TYPES.map((a) => (
                      <option key={a.v} value={a.v}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </FieldRow>
              </div>
            </>
          ) : (
            <>
              <FieldRow label="tipo de chave">
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {PIX_TYPES.map((p) => (
                    <button
                      key={p.v}
                      type="button"
                      onClick={() => setTipoPix(p.v)}
                      style={chipStyle(tipoPix === p.v)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </FieldRow>
              <FieldRow label="chave pix" required>
                <input
                  style={inputStyle}
                  placeholder={tipo.placeholder}
                  value={s.pixKey}
                  onChange={(e) => set({ pixKey: e.target.value })}
                  aria-label="chave pix"
                />
              </FieldRow>
            </>
          )}

          {/* Titular block */}
          <FieldRow label="nome do titular" required>
            <input
              style={inputStyle}
              placeholder="igual ao documento"
              value={s.nome}
              onChange={(e) => set({ nome: e.target.value })}
              aria-label="nome do titular"
            />
          </FieldRow>
          {/* aperture-chamy — removed the "cpf (travado)" display field: it
              only ever showed the mock CPF_FIXO (no real client-side session
              CPF source exists; the backend locks the CPF from the session on
              criarRecebedor). celular now spans the row. */}
          <FieldRow label="celular" required>
            <input
              style={inputStyle}
              placeholder="(00) 00000-0000"
              inputMode="numeric"
              value={s.telefone}
              onChange={(e) => set({ telefone: maskPhoneInline(e.target.value) })}
              aria-label="celular"
            />
          </FieldRow>
        </div>

        {inlineError && (
          <div
            role="alert"
            className="ex-modal-error"
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              background: "#F4D6CE",
              color: "#7B2A1A",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "11px",
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              marginBottom: 14,
            }}
          >
            {inlineError}
          </div>
        )}

        <div className="ex-modal-actions">
          <button
            type="button"
            className="ex-btn-ghost"
            onClick={onClose}
            disabled={isBusy}
          >
            cancelar
          </button>
          <button
            type="button"
            className="ex-btn-green"
            onClick={submit}
            disabled={isBusy || saldo === 0}
            aria-busy={isBusy}
          >
            {criarRecebedor.isPending
              ? "cadastrando…"
              : solicitarState.isPending
                ? "solicitando…"
                : "cadastrar e transferir"}
          </button>
        </div>
      </div>
    </>
  );
}

function FieldRow({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ink-mute)",
        }}
      >
        {label}
        {required && <span style={{ color: "var(--coral-pink, #c8567a)", marginLeft: 4 }}>*</span>}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--line)",
  background: "var(--paper, #fff)",
  fontSize: 14,
  fontFamily: "inherit",
  color: "var(--ink, #5c3a4f)",
};

const helperStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-mute)",
  marginTop: 2,
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "8px 12px",
    border: "none",
    borderRadius: 6,
    background: active ? "var(--paper, #fff)" : "transparent",
    color: active ? "var(--plum)" : "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
    boxShadow: active ? "0 1px 3px rgba(90,69,32,0.12)" : "none",
  };
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 999,
    border: active ? "1px solid var(--plum)" : "1px solid var(--line)",
    background: active ? "var(--plum)" : "var(--paper, #fff)",
    color: active ? "#fff" : "var(--ink-soft)",
    fontSize: 12,
    cursor: "pointer",
  };
}

function maskPhoneInline(s: string): string {
  const d = (s || "").replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/**
 * Map TRPCClientError-shape to operator-facing label. Per Rex's contract:
 *   - CONFLICT + message='repasse_ja_pendente'         → "transferência já solicitada"
 *   - UNPROCESSABLE_CONTENT + 'saldo_…insuficiente'    → "sem saldo disponível"
 *   - else                                              → "não foi possível solicitar"
 */
function formatSolicitarError(err: { code: string; message: string }): string {
  if (err.code === "CONFLICT" && err.message === "repasse_ja_pendente") {
    return "transferência já solicitada";
  }
  if (
    err.code === "UNPROCESSABLE_CONTENT" &&
    err.message === "saldo_disponivel_insuficiente"
  ) {
    return "sem saldo disponível";
  }
  return "não foi possível solicitar";
}

// ── Resgatado modal (all outgoing movements) ─────────────────────────────────
function ResgatadoModal({
  open,
  transactions,
  total,
  onClose,
}: {
  open: boolean;
  transactions: PresentesTx[];
  total: number;
  onClose: () => void;
}) {
  if (!open) return null;

  const outs = transactions
    .filter((x) => x.type === "out")
    .sort((a, b) => (b.d + b.t).localeCompare(a.d + a.t));

  return (
    <>
      <div className="ex-scrim is-open" onClick={onClose} />
      <div className="ex-modal ex-modal-wide" role="dialog" aria-label="Detalhes do resgatado">
        <header className="ex-modal-hd">
          <div>
            {/* aperture-2gceh — dropped the bogus hardcoded date range
                ("· 28/abr — 22/mai") that bore no relation to the actual
                transfer activity. No real range is on the wire for this
                modal, so the header now shows just the label. */}
            <span className="ex-caps">total resgatado</span>
            <h3 className="ex-modal-title neg">− {fmtMoney(total)}</h3>
          </div>
          <button type="button" className="ex-icon-btn" onClick={onClose} aria-label="Fechar">
            <IconClose />
          </button>
        </header>
        <p className="ex-modal-text">
          todas as saídas do período: resgates em loja e transferências para conta corrente.
        </p>
        <ul className="ex-resg-rows">
          {outs.map((x) => {
            const tint = STATUS_TINT[x.status];
            return (
              <li
                key={x.id}
                className="ex-resg-row"
                style={{ "--tint-bg": tint.bg, "--tint-stripe": tint.stripe } as React.CSSProperties}
              >
                <span className="ex-resg-stripe" />
                <div className="ex-resg-body">
                  <div className="ex-resg-l1">
                    <span className="ex-hand ex-resg-item">{x.item}</span>
                    <span className="ex-hand ex-resg-val">− {fmtMoney(x.amount)}</span>
                  </div>
                  <div className="ex-resg-l2">
                    <span className="ex-mono">{dateLong(x.d)} · {x.t}</span>
                    <span className="ex-mono">{tint.label}</span>
                  </div>
                  <div className="ex-resg-l3">para {x.guest}</div>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="ex-modal-actions ex-modal-actions-split">
          <span className="ex-caps">{outs.length} movimentações</span>
          <button type="button" className="ex-btn-primary" onClick={onClose}>
            fechar
          </button>
        </div>
      </div>
    </>
  );
}

// ── Body ─────────────────────────────────────────────────────────────────────
export function PresentesBody(props: PainelSectionBodyProps) {
  const [openTx, setOpenTx] = useState<PresentesTx | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [resgatadoOpen, setResgatadoOpen] = useState(false);
  const [activeStatuses, setActiveStatuses] = useState<PresentesStatus[]>([]);

  // slug → idCampanha resolution. Stub today (djb2-derived); swap target is
  // the real campanha-by-slug lookup when Rex's contract exposes one.
  //
  // aperture-kbmel — `hasRecebedor` drives the TransferModal's onboarding
  // branch. Currently MOCKED to `false` inside useStubCampanhaIdForSlug;
  // swap to `me.data?.hasRecebedor ?? false` when Rex extends `auth.me`.
  const {
    idCampanha,
    hasRecebedor,
    isLoading: campanhaLoading,
    error: campanhaError,
  } = useStubCampanhaIdForSlug(props.slug);

  // Fetch the FULL extrato (no wire-level statusFilters) and apply the chip
  // filter client-side. Keeps the existing "X de N" counter shape intact —
  // visibleTransactions is the filtered subset, transactions is the total.
  // For prod-scale lists this would need to flip to server-side filter +
  // a separate count query; today's scale (<20 rows in test, <100 in
  // realistic campanha) fits comfortably in the default cursor page.
  const summaryQuery = useStubExtratoSummary(idCampanha ?? "");
  const listQuery = useStubExtratoList({
    idCampanha: idCampanha ?? "",
  });

  // Solicitar transferência mutation. Lives at the body level so both the
  // TransferModal AND the post-success acknowledgement flow share state.
  // The mutation hook invalidates summary + list queries on success
  // (trpc.useUtils()-based; operator sees the new state without a manual
  // refresh).
  //
  // MUST run BEFORE the loading-gate early returns — React hooks rules
  // forbid conditional hook calls. The hook itself defends against
  // null idCampanha at mutate-time.
  const solicitarState = useStubSolicitarTransferencia({
    idCampanha,
    onSuccess: () => {
      setTransferOpen(false);
    },
  });

  // ── Loading / error / empty gates ──────────────────────────────────────
  if (campanhaLoading || summaryQuery.isLoading || listQuery.isLoading) {
    return <ExtratoLoadingState />;
  }
  if (campanhaError) {
    return <ExtratoErrorState message={campanhaError.message} />;
  }
  if (summaryQuery.error) {
    return <ExtratoErrorState message={summaryQuery.error.message} />;
  }
  if (listQuery.error) {
    return <ExtratoErrorState message={listQuery.error.message} />;
  }
  if (!summaryQuery.data || !listQuery.data) {
    return <ExtratoErrorState message="dados indisponíveis no momento" />;
  }

  const wireSummary = summaryQuery.data;
  const wireRows = listQuery.data.rows;

  // aperture-jszqp — no early short-circuit for the empty case. The extrato
  // layout itself renders gracefully with zero presentes: totals show
  // R$ 0,00 / 0 presentes (adaptSummary maps cents straight through),
  // the rows table renders its header + divider + an inline empty <li>
  // within the ticket sheet (NOT the full-screen generic empty screen).
  // Operator wants the recebedor's own extrato, just zeroed.

  // Adapt the wire shapes to what the existing visual layer consumes.
  const summary = adaptSummary(wireSummary);
  const transactions: PresentesTx[] = wireRows.map(adaptRow);

  // Computed header labels (replacing the pre-wire constants).
  const eventTitle = EVENT_TITLE_FALLBACK;
  const eventPeriod = formatEventPeriod(
    wireSummary.dateRangeStart,
    wireSummary.dateRangeEnd,
  );
  // aperture-sm7uc (#7): formatNextTransferLabel intentionally unused —
  // the próxima-transf chip is now driven off `aguardandoAprovacaoCents`
  // (presence of a solicitado RepasseRecebedor), not the next stripe
  // available_on date. Leaving the formatter in place for potential
  // reuse in the drawer's "previsão" copy block.
  void formatNextTransferLabel;

  const statusCounts = (() => {
    const counts: Partial<Record<PresentesStatus, number>> = {};
    for (const x of transactions) counts[x.status] = (counts[x.status] || 0) + 1;
    return counts;
  })();

  const visibleTransactions =
    activeStatuses.length === 0
      ? transactions
      : transactions.filter((x) => activeStatuses.includes(x.status));

  return (
    <section className="presentes-extrato">
      <style>{EXTRATO_CSS}</style>

      <div className="ex-main">
        <section className="ex-sheet">
          <span className="ex-washi ex-washi-tl" />
          <span className="ex-washi ex-washi-tr" />

          <header className="ex-sheet-hd">
            <div className="ex-sheet-eyebrow">
              <span className="ex-caps">{eventTitle}</span>
              <span className="ex-sheet-period ex-mono">{eventPeriod}</span>
            </div>

            <div className="ex-sheet-summary">
              <div className="ex-sm-col">
                <span className="ex-caps">total recebido</span>
                <span className="ex-hand pos">{fmtMoney(summary.recebido)}</span>
                <span className="ex-sm-sub">{summary.presentes} presentes</span>
              </div>
              <button
                type="button"
                className="ex-sm-col ex-sm-col-btn"
                onClick={() => setResgatadoOpen(true)}
                aria-label="Ver detalhes dos resgates"
              >
                <span className="ex-caps">resgatado</span>
                <span className="ex-hand neg">{fmtMoney(summary.resgatado)}</span>
                <span className="ex-sm-sub">ver detalhes →</span>
              </button>
              <div className="ex-sm-col ex-sm-col-main">
                <span className="ex-caps">saldo disponível</span>
                <span className="ex-hand ex-sm-main">
                  <span className="ex-mark">{fmtMoney(summary.disponivel)}</span>
                </span>
                <span className="ex-sm-sub">pronto pra resgatar</span>
              </div>
            </div>

            {/* aperture-fxfbk — collapsed two side-by-side CTAs (green
                "resgatar valores" + lilac "solicitar transferência") into
                one full-width green pill. Both buttons fired the same
                onClick → setTransferOpen(true), so the dual surface was
                pure noise. Single CTA reads cleaner and matches what
                payout actually does (one path: request a transfer).
                The existing `.ex-sheet-cta` rule has `flex: 1 1 200px`,
                so one child = full-width row by default.

                aperture-sm7uc (#9) — disabled when saldo disponivel is
                zero. Backend would surface 'saldo_disponivel_insuficiente'
                anyway, but disabling the CTA up-front saves the user a
                roundtrip and matches operator expectation ("greyed out =
                nothing to transfer"). The all-or-nothing confirm modal
                inside doesn't expose an amount input — there's no
                partial-withdrawal UI ever (locked decision s03dr). */}
            <div className="ex-sheet-cta-row">
              <button
                type="button"
                className="ex-sheet-cta green"
                onClick={() => setTransferOpen(true)}
                disabled={summary.disponivel === 0}
                aria-disabled={summary.disponivel === 0 || undefined}
              >
                <IconArrowUpRight />
                solicitar transferência
              </button>
            </div>

            <div className="ex-sheet-aux">
              <span className="ex-aux-pill amber">
                <span className="ex-aux-num">{fmtMoney(summary.aguardando)}</span>
                <span>aguardando liberação</span>
              </span>
              {/* aperture-1ut92 — admin-pipeline bucket. Renders only when
                  there's actually money in it; an empty pill reads as
                  visual noise. Lilac/purple matches the row badge for
                  in-flight solicitado lançamentos. */}
              {summary.aguardandoAprovacao > 0 && (
                <span className="ex-aux-pill lilac">
                  <span className="ex-aux-num">
                    {fmtMoney(summary.aguardandoAprovacao)}
                  </span>
                  <span>aguardando aprovação</span>
                </span>
              )}
              {/* aperture-lwkwx — `próxima transf.` chip removed.
                  It rendered the SAME value as `aguardando aprovação`
                  above (both keyed on `aguardandoAprovacao > 0`), which
                  duplicated information for no UX benefit. `aguardando
                  aprovação` is clearer about WHY the money isn't moving
                  yet (admin approval pending) so it's the chip we
                  keep. Operator's call: "why 2 tags that are the same
                  thing choos one or another please". */}
            </div>
          </header>

          <div className="ex-sheet-divider">
            <span className="ex-caps">
              extrato detalhado{activeStatuses.length > 0 && <> · <em>filtrado</em></>}
            </span>
            <div className="ex-sheet-divider-end">
              <span className="ex-mono">
                {visibleTransactions.length} de {transactions.length}
              </span>
              <FilterButton active={activeStatuses} counts={statusCounts} onChange={setActiveStatuses} />
            </div>
          </div>

          <ul className="ex-ticket-rows">
            {visibleTransactions.length === 0 &&
              (activeStatuses.length > 0 ? (
                <li className="ex-ticket-empty">
                  <span className="ex-hand">nenhum mimo com esse filtro</span>
                  <button type="button" className="ex-link" onClick={() => setActiveStatuses([])}>
                    limpar filtros
                  </button>
                </li>
              ) : (
                // aperture-jszqp — genuinely empty extrato (no presentes yet).
                // Inline empty row WITHIN the ticket sheet, not a filter prompt.
                <li className="ex-ticket-empty">
                  <span className="ex-hand">nenhum presente ainda ♡</span>
                </li>
              ))}
            {visibleTransactions.map((tx) => (
              <TicketRow key={tx.id} tx={tx} onPick={setOpenTx} />
            ))}
          </ul>

          <div className="ex-sheet-foot">
            <span className="ex-hand">fim do extrato ♡</span>
            <span className="ex-mono">pág. 1 / 1</span>
          </div>
        </section>
      </div>

      <DetailDrawer tx={openTx} onClose={() => setOpenTx(null)} />
      <TransferModal
        open={transferOpen}
        saldo={summary.disponivel}
        hasRecebedor={hasRecebedor}
        idCampanha={idCampanha}
        onClose={() => {
          setTransferOpen(false);
          solicitarState.reset();
        }}
        solicitarState={solicitarState}
      />
      <ResgatadoModal
        open={resgatadoOpen}
        transactions={transactions}
        total={summary.resgatado}
        onClose={() => setResgatadoOpen(false)}
      />
    </section>
  );
}

// Component-scoped recipe — ports the export's styles.css under .presentes-extrato.
// Brand tokens (--lilac*/--plum/--green*/--yellow/--coral-pink + fonts) come from
// the app shell; the cream "ticket sheet" vars (--sheet-*) are declared locally.
const EXTRATO_CSS = `
.presentes-extrato {
  --paper: #ffffff;
  --cream: #f8f7f6;
  --cream-2: #efece9;
  --line: #efe2e9;
  --plum: #6b3c5e;
  --ink: #5c3a4f;
  --ink-soft: #7a5a6c;
  --ink-mute: #a18a99;

  --sheet-bg: #f6e9d0;
  --sheet-bg-2: #f0dfbd;
  --sheet-band-deep: #b89f6b;
  --sheet-line: #d8c29a;
  --sheet-line-soft: rgba(184, 159, 107, 0.3);
  --sheet-ink: #5a4520;
  --sheet-ink-soft: #8a7547;
  --sheet-ink-mute: #b0a07a;
  --sheet-pos: #5b8a2e;
  --sheet-neg: #b5453b;

  --r-input: 12px;
  --r-pill: 999px;

  --hand: var(--font-patrick-hand), cursive;
  --mono: "DM Mono", ui-monospace, "SFMono-Regular", monospace;

  --shadow-lilac: 0 1px 0 rgba(255, 255, 255, 0.4) inset,
    0 8px 22px -4px rgba(167, 123, 190, 0.42), 0 2px 4px rgba(167, 123, 190, 0.18);
  --shadow-green: 0 1px 0 rgba(255, 255, 255, 0.4) inset,
    0 8px 22px -4px rgba(138, 165, 58, 0.4), 0 2px 4px rgba(138, 165, 58, 0.18);
  --shadow-sheet: 0 1px 0 rgba(255, 255, 255, 0.5) inset,
    0 2px 4px rgba(90, 69, 32, 0.1), 0 24px 56px -22px rgba(90, 69, 32, 0.32);

  --t-row-pad: 14px;
}
.presentes-extrato *, .presentes-extrato *::before, .presentes-extrato *::after { box-sizing: border-box; }

.presentes-extrato .ex-hand { font-family: var(--hand); font-weight: 400; }
.presentes-extrato .ex-mono { font-family: var(--mono); font-feature-settings: "tnum"; }
.presentes-extrato .ex-caps {
  font-family: var(--font-dm-sans), sans-serif;
  font-weight: 600; font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--ink-soft);
}
.presentes-extrato .ex-mark {
  background-image: linear-gradient(transparent 62%, var(--yellow) 62%, var(--yellow) 92%, transparent 92%);
  padding: 0 0.1em; border-radius: 2px;
}

/* ── layout ── */
.presentes-extrato .ex-main { margin: 18px auto 0; padding: 0 16px; max-width: 480px; }

/* ── sheet ── */
.presentes-extrato .ex-sheet {
  position: relative;
  background: linear-gradient(180deg, #faedd3 0%, var(--sheet-bg) 30%, var(--sheet-bg-2) 100%);
  box-shadow: var(--shadow-sheet);
  border-radius: 6px 6px 0 0;
  padding: 22px 20px 0;
  --scallop-r: 9px;
  --scallop-d: 18px;
  -webkit-mask:
    radial-gradient(var(--scallop-r) at 50% 0%, #0000 98%, #000) 0 100% / var(--scallop-d) var(--scallop-d) repeat-x,
    linear-gradient(#000, #000) top / 100% calc(100% - var(--scallop-r)) no-repeat;
  mask:
    radial-gradient(var(--scallop-r) at 50% 0%, #0000 98%, #000) 0 100% / var(--scallop-d) var(--scallop-d) repeat-x,
    linear-gradient(#000, #000) top / 100% calc(100% - var(--scallop-r)) no-repeat;
  -webkit-mask-composite: source-over;
  padding-bottom: calc(var(--scallop-r) + 16px);
}
.presentes-extrato .ex-sheet::before {
  content: ""; position: absolute; inset: 0;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.95' numOctaves='2' seed='8'/><feColorMatrix values='0 0 0 0 0.36 0 0 0 0 0.27 0 0 0 0 0.12 0 0 0 0.07 0'/></filter><rect width='200' height='200' filter='url(%23n)'/></svg>");
  mix-blend-mode: multiply; pointer-events: none; opacity: 0.8; z-index: 0;
}
.presentes-extrato .ex-sheet > * { position: relative; z-index: 1; }

.presentes-extrato .ex-washi {
  position: absolute; top: -14px; width: 78px; height: 22px;
  background: repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.35) 0 6px, transparent 6px 12px), var(--lilac);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.6) inset, 0 2px 8px -2px rgba(0, 0, 0, 0.12);
  border-radius: 1.5px; opacity: 0.9; z-index: 3;
}
.presentes-extrato .ex-washi-tl { left: 22px; transform: rotate(-7deg); background-color: var(--coral-pink); }
.presentes-extrato .ex-washi-tr { right: 22px; transform: rotate(6deg); background-color: var(--green); }

/* ── header ── */
.presentes-extrato .ex-sheet-hd {
  display: flex; flex-direction: column; gap: 14px;
  padding-bottom: 16px; border-bottom: 1.5px dashed var(--sheet-line);
}
.presentes-extrato .ex-sheet-eyebrow {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px; color: var(--sheet-ink-soft); padding-top: 4px; white-space: nowrap;
}
.presentes-extrato .ex-sheet-eyebrow .ex-caps { color: var(--sheet-ink-soft); font-size: 10.5px; }
.presentes-extrato .ex-sheet-period { color: var(--sheet-ink-soft); font-size: 10.5px; letter-spacing: 0.04em; }

.presentes-extrato .ex-sheet-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
.presentes-extrato .ex-sm-col {
  display: flex; flex-direction: column; gap: 4px; padding: 4px 6px; text-align: left; min-width: 0;
}
.presentes-extrato .ex-sm-col:first-child { border-right: 1px dashed var(--sheet-line); padding-right: 12px; }
.presentes-extrato .ex-sm-col:nth-child(2) { padding-left: 6px; }
.presentes-extrato .ex-sm-col .ex-caps { color: var(--sheet-ink-soft); font-size: 9.5px; }
.presentes-extrato .ex-sm-col .ex-hand {
  font-family: var(--hand); font-size: 22px; line-height: 1; color: var(--sheet-ink);
  font-feature-settings: "tnum"; white-space: nowrap;
}
.presentes-extrato .ex-sm-col .ex-hand.pos { color: var(--sheet-pos); }
.presentes-extrato .ex-sm-col .ex-hand.neg { color: var(--sheet-neg); }

.presentes-extrato .ex-sm-col-main {
  grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px;
  padding: 14px 16px; margin-top: 4px; background: rgba(255, 255, 255, 0.42);
  border-radius: 10px; border: 1px dashed var(--sheet-line); position: relative;
}
.presentes-extrato .ex-sm-col-main .ex-caps { color: var(--sheet-ink-soft); font-size: 9.5px; }
.presentes-extrato .ex-sm-col-main .ex-hand.ex-sm-main {
  font-family: var(--hand); font-size: 40px; line-height: 1; color: var(--plum);
  font-feature-settings: "tnum"; white-space: nowrap;
}
.presentes-extrato .ex-sm-sub { font-family: var(--font-caveat), cursive; font-size: 14px; color: var(--sheet-ink-mute); line-height: 1; }

.presentes-extrato .ex-sm-col-btn {
  appearance: none; cursor: pointer; text-align: left; border: 0; background: transparent;
  transition: background 0.14s, transform 0.12s; border-radius: 8px;
  margin: -4px -6px; padding-left: 12px; padding-right: 12px;
}
.presentes-extrato .ex-sm-col-btn:hover { background: rgba(255, 255, 255, 0.45); transform: translateY(-1px); }
.presentes-extrato .ex-sm-col-btn .ex-sm-sub { color: var(--lilac-deep); font-weight: 600; transition: color 0.14s; }
.presentes-extrato .ex-sm-col-btn:hover .ex-sm-sub { color: var(--sheet-neg); }

/* ── CTAs ── */
.presentes-extrato .ex-sheet-cta-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.presentes-extrato .ex-sheet-cta {
  flex: 1 1 200px; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 14px 18px; border: 0; cursor: pointer; border-radius: var(--r-input); color: #fff;
  font-family: var(--font-dm-sans), sans-serif; font-weight: 600;
  font-size: 11.5px; letter-spacing: 0.12em; text-transform: uppercase;
  transition: transform 0.12s, box-shadow 0.14s, background 0.14s;
}
.presentes-extrato .ex-sheet-cta.green { background: var(--green-deep); box-shadow: var(--shadow-green); }
.presentes-extrato .ex-sheet-cta.green:hover { background: #7c9532; transform: translateY(-1px); }
/* aperture-sm7uc (#9): disabled state — visual "no saldo, nothing to do" */
.presentes-extrato .ex-sheet-cta:disabled,
.presentes-extrato .ex-sheet-cta[aria-disabled="true"] {
  background: #c8c2bf; box-shadow: none; cursor: not-allowed; opacity: 0.7;
}
.presentes-extrato .ex-sheet-cta:disabled:hover,
.presentes-extrato .ex-sheet-cta[aria-disabled="true"]:hover {
  background: #c8c2bf; transform: none;
}
.presentes-extrato .ex-sheet-cta.lilac { background: var(--lilac-deep); box-shadow: var(--shadow-lilac); }
.presentes-extrato .ex-sheet-cta.lilac:hover { background: #9d6cb6; transform: translateY(-1px); }
.presentes-extrato .ex-sheet-cta:active { transform: translateY(0); }

.presentes-extrato .ex-sheet-aux { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.presentes-extrato .ex-aux-pill {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-radius: var(--r-pill); font-size: 11px; color: var(--sheet-ink-soft);
  background: rgba(255, 255, 255, 0.4); border: 1px solid var(--sheet-line-soft);
}
.presentes-extrato .ex-aux-pill.amber { background: rgba(247, 213, 96, 0.38); color: #7a5b0d; border-color: rgba(210, 168, 42, 0.4); }
.presentes-extrato .ex-aux-pill.lilac { background: rgba(201, 165, 216, 0.28); color: var(--lilac-deep); border-color: rgba(167, 123, 190, 0.35); }
.presentes-extrato .ex-aux-num { font-family: var(--hand); font-size: 14px; }

/* ── divider ── */
.presentes-extrato .ex-sheet-divider {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 14px 4px 10px; color: var(--sheet-ink-soft);
}
.presentes-extrato .ex-sheet-divider .ex-caps { color: var(--sheet-ink); font-size: 10.5px; }
.presentes-extrato .ex-sheet-divider .ex-mono { font-size: 10.5px; letter-spacing: 0.08em; }
.presentes-extrato .ex-sheet-divider-end { display: flex; align-items: center; gap: 10px; }

/* ── rows ── */
.presentes-extrato .ex-ticket-rows { list-style: none; margin: 0; padding: 0 0 12px; display: flex; flex-direction: column; gap: 6px; }
.presentes-extrato .ex-trow {
  position: relative; display: flex; align-items: stretch;
  background: var(--tint-bg, var(--paper)); border: 1px solid var(--sheet-line-soft);
  border-left-width: 0; border-radius: 8px; overflow: hidden; cursor: pointer;
  transition: transform 0.12s, box-shadow 0.12s, filter 0.12s;
}
.presentes-extrato .ex-trow:hover { transform: translateX(2px); filter: brightness(1.03); box-shadow: 0 2px 8px -2px rgba(90, 69, 32, 0.18); }
.presentes-extrato .ex-trow:focus-visible { outline: 2px solid var(--tint-stripe); outline-offset: -2px; }
.presentes-extrato .ex-trow.is-reversed { opacity: 0.72; }
.presentes-extrato .ex-t-stripe { flex: 0 0 6px; background: var(--tint-stripe); position: relative; }
.presentes-extrato .ex-t-stripe::after { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(255, 255, 255, 0.2), rgba(0, 0, 0, 0.08)); }
.presentes-extrato .ex-t-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding: var(--t-row-pad) 14px; }
.presentes-extrato .ex-t-l1 { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.presentes-extrato .ex-t-item-wrap {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px;
}
.presentes-extrato .ex-t-thumb {
  flex: 0 0 28px; width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 5px; overflow: hidden; background: rgba(255, 255, 255, 0.55);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.presentes-extrato .ex-t-thumb img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.presentes-extrato .ex-t-thumb-glyph {
  font-size: 20px; line-height: 1; font-family: var(--font-emoji, "Apple Color Emoji", "Segoe UI Emoji", sans-serif);
}
.presentes-extrato .ex-t-item {
  font-family: var(--hand); font-size: 19px; line-height: 1.1; color: var(--tint-ink, var(--sheet-ink));
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.presentes-extrato .ex-t-val {
  font-family: var(--hand); font-size: 21px; line-height: 1; font-feature-settings: "tnum";
  flex: 0 0 auto; white-space: nowrap; color: var(--tint-ink, var(--sheet-ink));
}
.presentes-extrato .ex-t-val.pos { color: var(--sheet-pos); }
.presentes-extrato .ex-t-val.neg { color: var(--sheet-neg); }
.presentes-extrato .ex-t-val.reversed { text-decoration: line-through; opacity: 0.7; }
.presentes-extrato .ex-t-l2 {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  font-size: 11.5px; color: var(--tint-ink, var(--sheet-ink-soft)); opacity: 0.82; min-width: 0;
}
.presentes-extrato .ex-t-from {
  font-family: var(--font-dm-sans), sans-serif; font-size: 12px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto;
}
.presentes-extrato .ex-t-from strong { font-weight: 600; color: var(--tint-ink, var(--sheet-ink)); opacity: 0.95; }
.presentes-extrato .ex-t-prep { color: var(--tint-ink, var(--sheet-ink-soft)); opacity: 0.65; }
.presentes-extrato .ex-t-meta { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; font-size: 10.5px; letter-spacing: 0.04em; }
.presentes-extrato .ex-t-status { font-weight: 600; text-transform: lowercase; letter-spacing: 0.02em; }
.presentes-extrato .ex-t-dot { opacity: 0.5; }
.presentes-extrato .ex-t-date { opacity: 0.8; }

/* ── foot ── */
.presentes-extrato .ex-sheet-foot {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 4px 4px; border-top: 1.5px dashed var(--sheet-line); color: var(--sheet-ink-soft);
}
.presentes-extrato .ex-sheet-foot .ex-hand { font-size: 18px; color: var(--sheet-ink); transform: rotate(-1deg); }
.presentes-extrato .ex-sheet-foot .ex-mono { font-size: 11px; letter-spacing: 0.06em; }

/* ── empty state ── */
.presentes-extrato .ex-ticket-empty {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  padding: 32px 16px; background: rgba(255, 255, 255, 0.4);
  border: 1px dashed var(--sheet-line); border-radius: 12px; text-align: center;
}
.presentes-extrato .ex-ticket-empty .ex-hand { font-family: var(--hand); font-size: 18px; color: var(--sheet-ink-soft); }

/* ── buttons (drawer/modal) ── */
.presentes-extrato .ex-btn-primary, .presentes-extrato .ex-btn-green {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  font-family: var(--font-dm-sans), sans-serif; font-weight: 600;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #fff;
  padding: 11px 16px; border: 0; cursor: pointer; border-radius: var(--r-input);
  transition: transform 0.12s, box-shadow 0.14s, background 0.14s;
}
.presentes-extrato .ex-btn-primary { background: var(--lilac-deep); box-shadow: var(--shadow-lilac); }
.presentes-extrato .ex-btn-primary:hover { background: #9d6cb6; transform: translateY(-1px); }
.presentes-extrato .ex-btn-green { background: var(--green-deep); box-shadow: var(--shadow-green); }
.presentes-extrato .ex-btn-green:hover { background: #7c9532; transform: translateY(-1px); }
.presentes-extrato .ex-btn-primary.block { width: 100%; }
.presentes-extrato .ex-btn-ghost {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  font-family: var(--font-dm-sans), sans-serif; font-weight: 500;
  font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-soft);
  padding: 10px 14px; border: 1px solid var(--line); cursor: pointer; border-radius: var(--r-input);
  background: transparent; transition: background 0.14s, color 0.14s, border-color 0.14s;
}
.presentes-extrato .ex-btn-ghost:hover { background: rgba(201, 165, 216, 0.1); color: var(--plum); border-color: rgba(201, 165, 216, 0.4); }
.presentes-extrato .ex-btn-ghost.block { width: 100%; }
.presentes-extrato .ex-link {
  font-family: var(--font-dm-sans), sans-serif; font-size: 12px; font-weight: 500;
  color: var(--lilac-deep); cursor: pointer; background: transparent; padding: 0; border: 0;
}
.presentes-extrato .ex-link:hover { text-decoration: underline; }

.presentes-extrato .ex-icon-btn {
  width: 32px; height: 32px; border-radius: 9px; border: 0; cursor: pointer; background: transparent;
  display: inline-flex; align-items: center; justify-content: center; color: var(--ink-soft);
  transition: background 0.14s, color 0.14s;
}
.presentes-extrato .ex-icon-btn:hover { background: rgba(201, 165, 216, 0.12); color: var(--plum); }
.presentes-extrato .ex-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

/* ── scrim + drawer ── */
.presentes-extrato .ex-scrim {
  position: fixed; inset: 0; background: rgba(107, 60, 94, 0.28);
  -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
  opacity: 0; pointer-events: none; transition: opacity 0.22s; z-index: 90;
}
.presentes-extrato .ex-scrim.is-open { opacity: 1; pointer-events: auto; }
.presentes-extrato .ex-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: 420px; max-width: 92vw;
  background: var(--cream); border-left: 1px solid var(--line);
  box-shadow: -20px 0 60px -20px rgba(107, 60, 94, 0.3);
  transform: translateX(100%); transition: transform 0.28s cubic-bezier(0.2, 0.7, 0.3, 1);
  z-index: 100; display: flex; flex-direction: column; padding: 22px 28px 28px; overflow-y: auto;
}
.presentes-extrato .ex-drawer.is-open { transform: translateX(0); }
.presentes-extrato .ex-drawer-hd { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
.presentes-extrato .ex-drawer-amount {
  font-family: var(--hand); display: flex; align-items: baseline; gap: 6px;
  color: var(--plum); margin: 14px 0 12px; font-feature-settings: "tnum"; line-height: 1;
}
.presentes-extrato .ex-drawer-sign { font-size: 36px; color: var(--sheet-pos); }
.presentes-extrato .ex-drawer-sign.out { color: var(--sheet-neg); }
.presentes-extrato .ex-drawer-currency { font-size: 22px; color: var(--ink-soft); }
.presentes-extrato .ex-drawer-num { font-size: 56px; }
.presentes-extrato .ex-drawer-status {
  display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: var(--r-pill);
  background: var(--paper); border: 1px solid var(--line); font-family: var(--font-dm-sans), sans-serif;
  font-size: 12px; font-weight: 600; color: var(--ink); margin-bottom: 22px; width: fit-content;
}
.presentes-extrato .ex-drawer-meta {
  display: grid; grid-template-columns: 1fr; gap: 0; padding: 6px 0; margin: 0 0 22px;
  border-top: 1px dashed var(--line); border-bottom: 1px dashed var(--line);
}
.presentes-extrato .ex-drawer-meta > div { display: grid; grid-template-columns: 130px 1fr; gap: 12px; padding: 11px 0; }
.presentes-extrato .ex-drawer-meta > div + div { border-top: 1px dotted var(--line); }
.presentes-extrato .ex-drawer-meta dt { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-mute); margin-top: 2px; }
.presentes-extrato .ex-drawer-meta dd { margin: 0; font-family: var(--font-dm-sans), sans-serif; font-size: 14px; font-weight: 500; color: var(--plum); line-height: 1.3; }
.presentes-extrato .ex-drawer-meta dd.ex-mono { font-family: var(--mono); font-size: 12px; font-weight: 400; color: var(--ink-soft); letter-spacing: 0.02em; }
.presentes-extrato .ex-drawer-item-dd { display: flex; align-items: center; gap: 8px; }
.presentes-extrato .ex-drawer-item-dd .ex-t-thumb { flex: 0 0 32px; width: 32px; height: 32px; }
.presentes-extrato .ex-drawer-item-dd .ex-t-thumb-glyph { font-size: 22px; }
.presentes-extrato .ex-drawer-actions { display: flex; flex-direction: column; gap: 10px; margin-top: auto; padding-top: 18px; }

/* ── modal ── */
.presentes-extrato .ex-modal {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 460px; max-width: 92vw; background: var(--paper); border: 1px solid var(--line);
  border-radius: 22px; box-shadow: 0 30px 80px -20px rgba(107, 60, 94, 0.45); padding: 26px 28px 24px; z-index: 110;
}
.presentes-extrato .ex-modal-wide { width: 540px; max-width: 92vw; padding: 24px 26px 22px; }
.presentes-extrato .ex-modal-hd { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; }
.presentes-extrato .ex-modal-title { font-family: var(--hand); font-size: 26px; margin: 4px 0 0; color: var(--plum); line-height: 1; }
.presentes-extrato .ex-modal-title.neg { font-size: 30px; color: var(--sheet-neg); font-feature-settings: "tnum"; }
.presentes-extrato .ex-modal-text { font-size: 13.5px; color: var(--ink-soft); line-height: 1.55; margin: 0 0 18px; }
.presentes-extrato .ex-modal-text strong { color: var(--plum); font-weight: 600; }
.presentes-extrato .ex-modal-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
.presentes-extrato .ex-modal-field > span:first-child { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-soft); }
.presentes-extrato .ex-modal-input {
  display: flex; align-items: center; gap: 8px; padding: 0 14px; background: var(--cream);
  border: 1.5px solid var(--line); border-radius: var(--r-input); transition: border-color 0.14s, background 0.14s;
}
.presentes-extrato .ex-modal-input:focus-within { border-color: var(--lilac); background: var(--paper); }
.presentes-extrato .ex-modal-input .prefix { font-family: var(--hand); font-size: 20px; color: var(--ink-soft); }
.presentes-extrato .ex-modal-input input { flex: 1; background: transparent; border: 0; outline: none; font-family: var(--hand); font-size: 26px; color: var(--plum); padding: 12px 0; font-feature-settings: "tnum"; }
.presentes-extrato .ex-hint { font-size: 12px; color: var(--ink-mute); }
.presentes-extrato .ex-modal-dest {
  display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 16px;
  background: var(--cream); border: 1px dashed var(--line); border-radius: var(--r-input); margin-bottom: 22px;
}
.presentes-extrato .ex-modal-dest-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-mute); margin-bottom: 4px; }
.presentes-extrato .ex-modal-dest-bank { font-family: var(--font-dm-sans), sans-serif; font-weight: 600; font-size: 14px; color: var(--plum); }
.presentes-extrato .ex-modal-dest-name { font-size: 12px; color: var(--ink-soft); margin-top: 2px; }
.presentes-extrato .ex-modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
.presentes-extrato .ex-modal-actions-split { justify-content: space-between; align-items: center; }

/* ── resgatado rows ── */
.presentes-extrato .ex-resg-rows {
  list-style: none; display: flex; flex-direction: column; gap: 6px; max-height: 50vh; overflow-y: auto;
  padding: 12px 2px; margin: 12px 0 18px; border-top: 1px dashed var(--line); border-bottom: 1px dashed var(--line);
}
.presentes-extrato .ex-resg-row {
  position: relative; display: flex; align-items: stretch; background: var(--tint-bg);
  border: 1px solid var(--sheet-line-soft); border-left-width: 0; border-radius: 10px; overflow: hidden;
}
.presentes-extrato .ex-resg-stripe { flex: 0 0 5px; background: var(--tint-stripe); }
.presentes-extrato .ex-resg-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; }
.presentes-extrato .ex-resg-l1 { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.presentes-extrato .ex-resg-item { font-family: var(--hand); font-size: 18px; color: var(--sheet-ink); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.presentes-extrato .ex-resg-val { font-family: var(--hand); font-size: 20px; color: var(--sheet-neg); font-feature-settings: "tnum"; flex: 0 0 auto; }
.presentes-extrato .ex-resg-l2 { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--sheet-ink-soft); margin-top: 2px; letter-spacing: 0.02em; }
.presentes-extrato .ex-resg-l3 { font-size: 11.5px; color: var(--sheet-ink-mute); font-family: var(--font-dm-sans), sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── filter ── */
.presentes-extrato .ex-filter { position: relative; display: inline-block; }
.presentes-extrato .ex-filter-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: var(--r-pill);
  border: 1px dashed var(--sheet-line); background: rgba(255, 255, 255, 0.4); color: var(--sheet-ink-soft);
  cursor: pointer; font-family: var(--font-dm-sans), sans-serif; font-weight: 600; font-size: 10.5px;
  letter-spacing: 0.08em; text-transform: uppercase; transition: background 0.14s, border-color 0.14s, color 0.14s;
}
.presentes-extrato .ex-filter-btn:hover, .presentes-extrato .ex-filter-btn.is-open { background: rgba(255, 255, 255, 0.7); border-color: var(--sheet-band-deep); color: var(--sheet-ink); }
.presentes-extrato .ex-filter-btn.is-active { background: var(--lilac-soft); border-color: var(--lilac-deep); color: var(--lilac-deep); }
.presentes-extrato .ex-filter-badge {
  display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px;
  padding: 0 4px; border-radius: 999px; background: var(--lilac-deep); color: #fff; font-size: 9.5px; font-weight: 700;
}
/* aperture-sm7uc (#8) — panel selector duplicated for both the in-tree
   fallback case (.presentes-extrato .ex-filter-panel) and the portalled
   variant (.presentes-extrato-portal at <body> level). Color tokens
   resolved against :root because the portalled panel lives outside
   the .presentes-extrato scope where the local --paper / --line vars
   are declared. */
.presentes-extrato .ex-filter-panel,
.ex-filter-panel.presentes-extrato-portal {
  width: 260px; background: #ffffff;
  border: 1px solid #efe2e9; border-radius: 14px;
  box-shadow: 0 16px 40px -8px rgba(107, 60, 94, 0.28), 0 2px 8px rgba(107, 60, 94, 0.08), 0 1px 0 rgba(255, 255, 255, 0.5) inset;
  padding: 12px 14px;
  color: #5c3a4f;
  font-family: var(--font-dm-sans), sans-serif;
}
.ex-filter-panel.presentes-extrato-portal .ex-caps {
  font-family: var(--font-dm-sans), sans-serif;
  font-weight: 600; font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: #7a5a6c;
}
.ex-filter-panel.presentes-extrato-portal .ex-link {
  font-family: var(--font-dm-sans), sans-serif; font-size: 12px; font-weight: 500;
  color: var(--lilac-deep, #8a5da6); cursor: pointer; background: transparent; padding: 0; border: 0;
}
.ex-filter-panel.presentes-extrato-portal .ex-filter-panel-hd {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
}
.ex-filter-panel.presentes-extrato-portal .ex-filter-pills {
  display: flex; flex-direction: column; gap: 6px;
}
.ex-filter-panel.presentes-extrato-portal .ex-filter-pill {
  display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 10px;
  border: 1px solid #efe2e9; background: #f8f7f6; color: #7a5a6c; cursor: pointer;
  font-size: 12px; font-weight: 500; text-align: left; transition: background 0.12s, border-color 0.12s, color 0.12s;
  font-family: var(--font-dm-sans), sans-serif;
}
.ex-filter-panel.presentes-extrato-portal .ex-filter-pill:hover {
  background: #efece9; color: #5c3a4f;
}
.ex-filter-panel.presentes-extrato-portal .ex-filter-pill.is-on { font-weight: 600; }
.ex-filter-panel.presentes-extrato-portal .ex-filter-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.ex-filter-panel.presentes-extrato-portal .ex-filter-count {
  margin-left: auto; font-family: "DM Mono", ui-monospace, "SFMono-Regular", monospace;
  font-size: 11px; color: #a18a99; font-feature-settings: "tnum";
}
.ex-filter-panel.presentes-extrato-portal .ex-filter-pill.is-on .ex-filter-count {
  color: inherit; opacity: 0.7;
}
.presentes-extrato .ex-filter-panel-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.presentes-extrato .ex-filter-pills { display: flex; flex-direction: column; gap: 6px; }
.presentes-extrato .ex-filter-pill {
  display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--cream); color: var(--ink-soft); cursor: pointer;
  font-size: 12px; font-weight: 500; text-align: left; transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.presentes-extrato .ex-filter-pill:hover { background: var(--cream-2); color: var(--ink); }
.presentes-extrato .ex-filter-pill.is-on { font-weight: 600; }
.presentes-extrato .ex-filter-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.presentes-extrato .ex-filter-count { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--ink-mute); font-feature-settings: "tnum"; }
.presentes-extrato .ex-filter-pill.is-on .ex-filter-count { color: inherit; opacity: 0.7; }

/* ── responsive ── */
@media (max-width: 760px) {
  .presentes-extrato .ex-main { padding: 0 12px; }
  .presentes-extrato .ex-sheet { padding: 22px 16px 0; }
  .presentes-extrato .ex-sm-col .ex-hand { font-size: 19px; }
  .presentes-extrato .ex-sm-col .ex-hand.ex-sm-main { font-size: 28px; }
  .presentes-extrato .ex-washi { width: 64px; height: 18px; }
  .presentes-extrato .ex-filter-panel { right: -8px; width: 240px; }
}
`;
