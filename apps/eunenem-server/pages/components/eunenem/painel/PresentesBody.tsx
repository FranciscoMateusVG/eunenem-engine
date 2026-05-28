import { useEffect, useMemo, useRef, useState } from "react";

import type { PainelSectionBodyProps } from "@/PainelSectionPage";
import {
  FILTER_OPTIONS,
  fmtMoney,
  dateLong,
  dateShort,
  PRESENTES_TX,
  STATUS_TINT,
  summarize,
  type PresentesStatus,
  type PresentesTx,
} from "@/lib/mocks/presentes";

// aperture-xjwc — "Presentes recebidos" (extrato + resgatar).
//
// A cream paper "ticket sheet" (washi tape, scalloped bottom edge, paper noise)
// holding: a summary header (RECEBIDO / RESGATADO + a full-width DISPONÍVEL
// block with yellow marca-texto), a green "resgatar" CTA in the header card,
// a lilás "solicitar transferência" CTA inside the sheet, aux pills, a status
// filter popover, and the status-tinted ticket rows. Clicking a row opens a
// detail drawer; the resgatado summary opens a wide modal; the CTAs open the
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

const EVENT_PERIOD = "28/abr — 22/mai · 2026";
const EVENT_TITLE = "extrato · chá da Mari";
const NEXT_TRANSFER_LABEL = "qui · 26/mai";

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

function IconDownload() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function IconWallet() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (k: PresentesStatus) => {
    onChange(active.includes(k) ? active.filter((x) => x !== k) : [...active, k]);
  };

  return (
    <div className="ex-filter" ref={ref}>
      <button
        type="button"
        className={`ex-filter-btn ${open ? "is-open " : ""}${active.length ? "is-active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <IconFilter />
        filtrar status
        {active.length > 0 && <span className="ex-filter-badge">{active.length}</span>}
      </button>

      {open && (
        <div className="ex-filter-panel" role="menu">
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
        </div>
      )}
    </div>
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
          <span className="ex-t-item">{tx.item}</span>
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
            <span className="ex-t-date ex-mono">{dateShort(tx.d)} · {tx.t}</span>
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
            <dd>{t.item}</dd>
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
          <div>
            <dt>horário</dt>
            <dd>{t.t}</dd>
          </div>
          <div>
            <dt>identificador</dt>
            <dd className="ex-mono">PRT-{t.id.toUpperCase()}-2026</dd>
          </div>
          {t.status === "tSolicitada" && (
            <div>
              <dt>previsão</dt>
              <dd>próximo dia útil</dd>
            </div>
          )}
          {t.status === "aguardando" && (
            <div>
              <dt>previsão</dt>
              <dd>libera em até 72h</dd>
            </div>
          )}
          {t.status === "estornado" && (
            <div>
              <dt>motivo</dt>
              <dd>pagamento não confirmado pelo banco em 72h.</dd>
            </div>
          )}
        </dl>

        <div className="ex-drawer-actions">
          {isIn && t.status !== "estornado" && (
            <button type="button" className="ex-btn-primary block" onClick={onClose}>
              enviar agradecimento à {firstName}
            </button>
          )}
          <button type="button" className="ex-btn-ghost block" onClick={onClose}>
            <IconDownload />
            baixar comprovante
          </button>
        </div>
      </aside>
    </>
  );
}

// ── Transfer modal ───────────────────────────────────────────────────────────
function TransferModal({
  open,
  saldo,
  onClose,
}: {
  open: boolean;
  saldo: number;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState("");
  useEffect(() => {
    if (open) setAmount((saldo / 100).toFixed(2).replace(".", ","));
  }, [open, saldo]);

  if (!open) return null;

  return (
    <>
      <div className="ex-scrim is-open" onClick={onClose} />
      <div className="ex-modal" role="dialog" aria-label="Solicitar transferência">
        <header className="ex-modal-hd">
          <div>
            <span className="ex-caps">solicitar transferência</span>
            <h3 className="ex-modal-title">retirar do saldo</h3>
          </div>
          <button type="button" className="ex-icon-btn" onClick={onClose} aria-label="Fechar">
            <IconClose />
          </button>
        </header>
        <p className="ex-modal-text">
          o valor é enviado para a conta de destino em <strong>até 1 dia útil</strong>. você recebe
          um aviso por e-mail quando o pagamento for confirmado.
        </p>
        <label className="ex-modal-field">
          <span>valor</span>
          <div className="ex-modal-input">
            <span className="prefix">R$</span>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            <button
              type="button"
              className="ex-link"
              onClick={() => setAmount((saldo / 100).toFixed(2).replace(".", ","))}
            >
              usar tudo
            </button>
          </div>
          <span className="ex-hint">disponível: {fmtMoney(saldo)}</span>
        </label>
        <div className="ex-modal-dest">
          <div>
            <div className="ex-modal-dest-label">destino</div>
            <div className="ex-modal-dest-bank">Banco Inter · ag. 0001 · c/c 12345-6</div>
            <div className="ex-modal-dest-name">Mariana Vasconcelos · CPF ***.***.***-12</div>
          </div>
          <button type="button" className="ex-link">
            trocar
          </button>
        </div>
        <div className="ex-modal-actions">
          <button type="button" className="ex-btn-ghost" onClick={onClose}>
            cancelar
          </button>
          <button type="button" className="ex-btn-green" onClick={onClose}>
            solicitar transferência
          </button>
        </div>
      </div>
    </>
  );
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
            <span className="ex-caps">total resgatado · 28/abr — 22/mai</span>
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
export function PresentesBody(_props: PainelSectionBodyProps) {
  const [openTx, setOpenTx] = useState<PresentesTx | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [resgatadoOpen, setResgatadoOpen] = useState(false);
  const [activeStatuses, setActiveStatuses] = useState<PresentesStatus[]>([]);

  const summary = useMemo(() => summarize(PRESENTES_TX), []);
  const transactions = PRESENTES_TX;

  const statusCounts = useMemo(() => {
    const counts: Partial<Record<PresentesStatus, number>> = {};
    for (const x of transactions) counts[x.status] = (counts[x.status] || 0) + 1;
    return counts;
  }, [transactions]);

  const visibleTransactions = useMemo(() => {
    if (!activeStatuses.length) return transactions;
    return transactions.filter((x) => activeStatuses.includes(x.status));
  }, [transactions, activeStatuses]);

  return (
    <section className="presentes-extrato">
      <style>{EXTRATO_CSS}</style>

      <div className="ex-main">
        <section className="ex-sheet">
          <span className="ex-washi ex-washi-tl" />
          <span className="ex-washi ex-washi-tr" />

          <header className="ex-sheet-hd">
            <div className="ex-sheet-eyebrow">
              <span className="ex-caps">{EVENT_TITLE}</span>
              <span className="ex-sheet-period ex-mono">{EVENT_PERIOD}</span>
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

            <div className="ex-sheet-cta-row">
              <button type="button" className="ex-sheet-cta green" onClick={() => setTransferOpen(true)}>
                <IconWallet />
                resgatar valores
              </button>
              <button type="button" className="ex-sheet-cta lilac" onClick={() => setTransferOpen(true)}>
                <IconArrowUpRight />
                solicitar transferência
              </button>
            </div>

            <div className="ex-sheet-aux">
              <span className="ex-aux-pill amber">
                <span className="ex-aux-num">{fmtMoney(summary.aguardando)}</span>
                <span>aguardando liberação</span>
              </span>
              <span className="ex-aux-pill lilac">
                <span>próxima transf.</span>
                <span className="ex-aux-num">{NEXT_TRANSFER_LABEL}</span>
              </span>
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
            {visibleTransactions.length === 0 && (
              <li className="ex-ticket-empty">
                <span className="ex-hand">nenhum mimo com esse filtro</span>
                <button type="button" className="ex-link" onClick={() => setActiveStatuses([])}>
                  limpar filtros
                </button>
              </li>
            )}
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
      <TransferModal open={transferOpen} saldo={summary.disponivel} onClose={() => setTransferOpen(false)} />
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
.presentes-extrato .ex-t-l1 { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
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
.presentes-extrato .ex-filter-panel {
  position: absolute; top: calc(100% + 6px); right: 0; width: 260px; background: var(--paper);
  border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 16px 40px -8px rgba(107, 60, 94, 0.28), 0 2px 8px rgba(107, 60, 94, 0.08), 0 1px 0 rgba(255, 255, 255, 0.5) inset;
  padding: 12px 14px; z-index: 20;
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
