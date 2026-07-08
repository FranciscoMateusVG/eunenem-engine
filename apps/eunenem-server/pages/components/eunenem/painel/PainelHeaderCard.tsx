
import { useEffect, useState } from "react";
import { artigoPosse } from "@/lib/concordancia";
import { toast } from "sonner";
import { useTweaks } from "../TweaksContext";
import type { PainelEventSnapshot } from "@/lib/mocks/painelDemo";
import { painelHref } from "@/lib/painelRoutes";
import { useCampanhaRota } from "@/lib/campanha-rota";

// aperture-9qu7k — Painel root hero composition (target screenshot 32).
//
// Restructured from the aperture-i01o single-card hero into three
// stacked blocks:
//   1. Top strip — faltam-pouquinho eyebrow + inline countdown line
//      on the left, big purple COMPARTILHE pill on the right. Share
//      action moves UP out of the URL row.
//   2. Title row — eyebrow "olá, {name}" + h1 "página da <Helena>"
//      + a compact URL chip row (calendar icon · date pill · middle
//      dot · eunenem.com/<colored slug>). The dedicated copy + share
//      circle previously sitting in this row are GONE.
//   3. Recebido card — single white rounded card with the
//      "recebido até agora" label, a centered plum amount, a
//      full-width green RESGATAR VALORES pill, and a 3-column
//      PRESENTES / CONFIRMADOS / RECADOS stat strip beneath.
//      (aperture-rxsm7 dropped the inline AO VIVO badge that the
//      original 9qu7k spec called for — matches dmur2's earlier
//      removal of the same badge on the prior hero card.)
//
// Wiring:
// - babyName + targetDate come from TweaksContext (drives countdown
//   days + the inline pretty-date label) as before.
// - share URL copy is the same navigator.clipboard + sonner toast
//   recipe as aperture-i01o.
// - Stats numbers come directly from the snapshot
//   (giftsClaimed / guestsConfirmed / messagesTotal) — no new mock
//   fields required, the data was already in PAINEL_DEMO.
//
// CSS lives in tailwind.css under the /* aperture-9qu7k */ block.
// Pre-existing aperture-i01o selectors (.painel-header-card,
// .painel-hc-*) are left in place to avoid breaking the snapshot
// suite; the new layout uses fresh .painel-top-strip / .painel-title-
// row / .painel-recebido-card / .painel-stats selectors.

interface Props {
  snapshot: PainelEventSnapshot;
  /** Painel slug — needed to build the RESGATAR pill href to the
   *  extrato page (`/painel/<slug>/presentes`). */
  slug: string;
  /**
   * aperture-snfin — the DISPLAYED campanha's titulo (clicked /c/:id, or the
   * default/oldest on a bare URL), resolved by PainelPage via campanhas.list.
   * Renders as the identity chip so clicking card A vs card B shows painel A
   * vs painel B (Izzy's 118sb gate asserts its text). null = still
   * resolving (chip shows a placeholder — never the wrong campanha);
   * undefined = list unavailable (chip hidden).
   */
  campanhaTitulo?: string | null;
}

const MONTHS_PT = [
  "jan", "fev", "mar", "abr", "mai", "jun",
  "jul", "ago", "set", "out", "nov", "dez",
];

export function PainelHeaderCard({ snapshot, slug, campanhaTitulo }: Props) {
  const idCampanha = useCampanhaRota();
  const { tweaks } = useTweaks();
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  // 30s tick is plenty for a day-resolution countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // aperture-84a21 — only render the countdown + date chip when there's a REAL
  // event date. A fresh account (dataEvento null → tweaks.targetDate "") must
  // NOT show the old mock "15 jun 2026" / "0 dias". The operator's tweaks panel
  // still drives both when a date is set.
  const rawTarget = (tweaks.targetDate ?? "").trim();
  const targetDate = rawTarget ? new Date(`${rawTarget}T16:00:00-03:00`) : null;
  const hasDate = targetDate !== null && !Number.isNaN(targetDate.getTime());
  const weekdayPt = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  const daysLeft = hasDate
    ? Math.max(0, Math.floor((targetDate.getTime() - now) / 86_400_000))
    : 0;
  const inlineDate = hasDate
    ? `${targetDate.getDate()} ${MONTHS_PT[targetDate.getMonth()]}, ${weekdayPt[targetDate.getDay()]} · 16h`
    : "";
  const chipDate = hasDate
    ? `${targetDate.getDate()} ${MONTHS_PT[targetDate.getMonth()]} ${targetDate.getFullYear()}`
    : "";

  const reais = (snapshot.receivedCents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const [reaisInt, reaisCents] = reais.split(",");

  const babyNameDisplay = tweaks.babyName;
  const fullShareUrl = `https://${snapshot.shareUrl}${snapshot.shareSlug}`;

  const onCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fullShareUrl);
      }
    } catch {
      // fall through — still toast as visual confirmation
    }
    setCopied(true);
    toast.success("link copiado ♡");
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      {/* 1. Top strip — countdown eyebrow + share CTA */}
      <section className="painel-top-strip" aria-label="contagem regressiva e link do evento">
        <div className="painel-top-strip-left">
          <span className="painel-top-strip-eyebrow">
            {hasDate ? "falta pouco ♡" : "sua página tá no ar ♡"}
          </span>
          {hasDate && (
            <span className="painel-top-strip-line">
              {daysLeft} dias · {inlineDate}
            </span>
          )}
        </div>
        <button
          type="button"
          className="painel-share-cta"
          onClick={onCopy}
          aria-label="copiar link do evento"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ width: 14, height: 14, strokeWidth: 2.2 }}
            aria-hidden="true"
          >
            {/* sparkle — ✦ shape, traced inline (no new dep) */}
            <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.5 5.5l2.5 2.5M16 16l2.5 2.5M5.5 18.5l2.5-2.5M16 8l2.5-2.5" />
          </svg>
          <span className="painel-share-cta-label">
            {copied ? "link copiado ♡" : "compartilhe o link do evento"}
          </span>
        </button>
      </section>

      {/* 2. Title row — greeting + h1 + url chip line */}
      <header className="painel-title-row">
        <span className="painel-hc-greeting">
          olá{snapshot.greetingTo ? `, ${snapshot.greetingTo}` : ""} ♡
        </span>
        {/* aperture-snfin — which list this painel belongs to. Uniform across
         *  bare (oldest) + /c/:id (clicked) routes; Izzy's click-through gate
         *  asserts this text equals the campanha titulo. */}
        {campanhaTitulo !== undefined && (
          <span className="painel-campanha-chip" data-testid="painel-campanha-titulo">
            {campanhaTitulo ?? "…"}
          </span>
        )}
        <h1 className="painel-hc-title">
          página {artigoPosse(tweaks.genero)} <span className="hl">{babyNameDisplay}</span>
        </h1>
        <div className="painel-url-row">
          {/* aperture-84a21 — calendar icon + date chip only when a real event
              date is set (no mock "15 jun 2026" on a fresh account). */}
          {hasDate && (
            <>
              <span className="painel-url-cal" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: 14, height: 14, strokeWidth: 2 }}
                >
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                  <line x1="8" y1="3" x2="8" y2="7" />
                  <line x1="16" y1="3" x2="16" y2="7" />
                </svg>
              </span>
              <span className="painel-url-date">{chipDate}</span>
              <span className="painel-url-dot" aria-hidden="true">·</span>
            </>
          )}
          <span className="painel-url-link">
            {snapshot.shareUrl}
            <a
              href={fullShareUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="painel-url-slug"
            >
              {snapshot.shareSlug}
            </a>
          </span>
        </div>
      </header>

      {/* 3. Recebido card — amount + RESGATAR + 3-col stats.
          aperture-rxsm7 — removed the "ao vivo" pulse badge. dmur2
          (PR #20) already killed the same badge on the prior
          hero-card layout; the 9qu7k spec accidentally reintroduced
          it inside this new recebido card. The dashboard is private
          and the amount updates implicitly on snapshot refresh, so
          the live-stream framing was marketing noise on a private
          figure both times. */}
      <section className="painel-recebido-card" aria-label="recebido até agora">
        <div className="painel-recebido-head">
          <span className="painel-recebido-lbl">recebido até agora</span>
        </div>
        <div className="painel-recebido-amount">
          <small>R$</small>
          {reaisInt}
          <span className="painel-recebido-cents">,{reaisCents}</span>
        </div>
        {/* aperture-sm7uc (#2 fix) — pill was a dead <button>. Navigates
            to the extrato (presentes) sub-page so the operator lands on
            the place that actually lets them resgatar. Render an <a>
            (not a button) so the painel router picks it up via the same
            full-page nav path every other menu row uses. */}
        <a
          href={painelHref(slug, "presentes", idCampanha)}
          className="painel-recebido-cta"
        >
          <span>resgatar valores</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ width: 16, height: 16, strokeWidth: 2.2 }}
            aria-hidden="true"
          >
            <path d="M5 12h14" />
            <path d="M13 5l7 7-7 7" />
          </svg>
        </a>
        <div className="painel-stats" role="group" aria-label="resumo do evento">
          {/* aperture-kvpvf — strip swap from snapshot.giftsClaimed
              (distinct-pagamento count) to snapshot.presentesStripCount
              (item-row count). Operator expectation: 5-item cart counts
              as 5 PRESENTES here. The featured "presentes recebidos"
              card on the menu still reads giftsClaimed (distinct
              pagamentos) — those are two intentionally different
              numbers on the same page. */}
          <div className="painel-stat">
            <div className="painel-stat-num">{snapshot.presentesStripCount}</div>
            <div className="painel-stat-lbl">presentes</div>
          </div>
          <div className="painel-stat">
            <div className="painel-stat-num">{snapshot.guestsConfirmed}</div>
            <div className="painel-stat-lbl">confirmados</div>
          </div>
          {/* aperture-kvpvf — strip swap from snapshot.messagesTotal
              (mock 12) to snapshot.recadosStripCount (real count). The
              "mensagens recebidas" menu row still reads messagesTotal
              (separate follow-up bead aperture-mztrb covers that). */}
          <div className="painel-stat">
            <div className="painel-stat-num">{snapshot.recadosStripCount}</div>
            <div className="painel-stat-lbl">recados</div>
          </div>
        </div>
      </section>
    </>
  );
}
