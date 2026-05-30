
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTweaks } from "../TweaksContext";
import type { PainelEventSnapshot } from "@/lib/mocks/painelDemo";

// aperture-i01o — Painel unified hero card.
//
// One card that holds: greeting + title + share-link pill on top, and
// a stats strip (countdown · recebido + CTA) on the bottom. Single
// column on mobile, 2-column stats grid + flex-row top on desktop.
//
// The radial lilac gradient bleed in the upper-right corner is per
// Thacy v3 — kept as a pseudo-element so it never intercepts pointer
// events. The marca-texto highlight wraps the baby name only (never
// the full phrase) per Visual Identity Prompt §5.
//
// Wiring:
// - babyName + targetDate come from TweaksContext so the existing
//   TweaksPanel (from PR #1) drives them live.
// - greetingTo / shareSlug / receivedCents / gift counts come from
//   the snapshot prop (PAINEL_DEMO).
// - Countdown ticks live in-component on a 30s setInterval. Stops
//   updating once the event date passes.
// - Copy link uses navigator.clipboard with a sonner toast on success
//   and the .copied visual state on the button.

interface Props {
  snapshot: PainelEventSnapshot;
}

export function PainelHeaderCard({ snapshot }: Props) {
  const { tweaks } = useTweaks();
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());

  // 30s tick — minutes resolution is plenty for a tea-party
  // countdown and avoids the per-second wakeup tax on mobile.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const target = new Date(`${tweaks.targetDate}T16:00:00-03:00`).getTime();
  const diff = Math.max(0, target - now);
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

  const reais = (snapshot.receivedCents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const [reaisInt, reaisCents] = reais.split(",");

  // Mockup v3 line 429 capitalizes the baby name inside the
  // marca-texto ("página da Helena"). Sterling caught a regression
  // where this rendered lowercase — preserving the case of the
  // tweaks.babyName value directly so the route slug seed ("Helena")
  // and any operator override both display naturally.
  const babyNameDisplay = tweaks.babyName;

  const fullShareUrl = `https://${snapshot.shareUrl}${snapshot.shareSlug}`;

  const onCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fullShareUrl);
      }
    } catch {
      // fall through — still show the visual confirmation
    }
    setCopied(true);
    toast.success("link copiado ♡");
    setTimeout(() => setCopied(false), 1800);
  };

  const onShare = async () => {
    // navigator.share is iOS Safari + Android Chrome on real devices
    // only; desktop falls back to copy as a sensible default.
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
      try {
        await navigator.share({
          title: "EuNeném — chá da " + tweaks.babyName,
          text: "venha celebrar com a gente ♡",
          url: fullShareUrl,
        });
        return;
      } catch {
        // user cancelled — silent
        return;
      }
    }
    void onCopy();
  };

  return (
    <section className="painel-header-card">
      <div className="painel-hc-top">
        <div>
          <span className="painel-hc-greeting">
            olá, {snapshot.greetingTo} ♡
          </span>
          <h1 className="painel-hc-title">
            página da <span className="hl">{babyNameDisplay}</span>
          </h1>
        </div>

        <div className="painel-share-link">
          <span className="painel-share-link-lbl">link do evento</span>
          <span className="painel-share-link-url">
            {snapshot.shareUrl}
            <strong>{snapshot.shareSlug}</strong>
          </span>
          <span className="painel-share-link-actions">
            <button
              type="button"
              onClick={onCopy}
              aria-label={copied ? "link copiado" : "copiar link"}
              className={`painel-share-btn ghost ${copied ? "copied" : ""}`}
            >
              <span className="painel-share-btn-label-default">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: 14, height: 14, strokeWidth: 2.2 }}
                  aria-hidden="true"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                {/* aperture-46cs — text wrapped in a span so the
                    narrow-phone media query can target it directly.
                    Previously the label sat as a bare text node,
                    making the `:not(svg)` selector dead (text nodes
                    aren't element children). */}
                <span className="painel-share-label">copiar</span>
              </span>
              <span className="painel-share-btn-label-copied">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: 14, height: 14, strokeWidth: 2.2 }}
                  aria-hidden="true"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="painel-share-label">copiado!</span>
              </span>
            </button>
            <button
              type="button"
              onClick={onShare}
              aria-label="compartilhar link do evento"
              className="painel-share-btn primary"
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
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
                <line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
              </svg>
              <span className="painel-share-label">compartilhar</span>
            </button>
          </span>
        </div>
      </div>

      <div className="painel-hc-stats">
        <div className="painel-hc-stat">
          <div className="painel-hc-stat-lbl">faltam para o chá</div>
          <div className="painel-cd-units">
            <div className="painel-cd-unit">
              <div className="painel-cd-num">{days}</div>
              <div className="painel-cd-lbl">dias</div>
            </div>
            <div className="painel-cd-unit">
              <div className="painel-cd-num">{pad(hours)}</div>
              <div className="painel-cd-lbl">horas</div>
            </div>
            <div className="painel-cd-unit">
              <div className="painel-cd-num">{pad(minutes)}</div>
              <div className="painel-cd-lbl">min</div>
            </div>
          </div>
          <span className="painel-cd-date">12 jun, sex · 16h</span>
        </div>

        <div className="painel-hc-stat">
          {/* aperture-dmur2 — removed the "ao vivo" pulse badge that
              sat next to this label. The amount already updates
              implicitly on data refresh, and the badge was reading
              as marketing noise next to a private dashboard figure. */}
          <div className="painel-hc-stat-lbl">recebido até agora</div>
          <div className="painel-hc-amount">
            <small>R$</small>
            {reaisInt}
            <span className="painel-hc-cents">,{reaisCents}</span>
          </div>
          <div className="painel-hc-amount-sub">
            {snapshot.giftsClaimed}/{snapshot.giftsTotal} presentes
          </div>
          <button type="button" className="painel-hc-cta">
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
          </button>
        </div>
      </div>
    </section>
  );
}
