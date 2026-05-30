
import { useEffect, useState } from "react";

// aperture-3d9t / aperture-yv2v / aperture-pve6 / aperture-xijyq — countdown
// to baby's expected arrival date. Client component; computes ONCE on mount.
//
// HYDRATION HISTORY (read this before changing the pattern):
//
// 1. Original (aperture-3d9t) — null sentinel rendered "0 dias 0 horas
//    0 min 0 segundos" in SSG, looked like the countdown was AT zero
//    (event already happened). Peppy caught this in prod.
//
// 2. aperture-yv2v — lazy initializer + parent `suppressHydrationWarning`.
//    SSG showed realistic build-time numbers (no 0/0/0/0), but supp-
//    ressHydrationWarning only suppresses ONE LEVEL deep — the
//    descendant CountdownUnit value divs still threw React error #418
//    in prod (caught by Sterling on i01o review). Plus build-time
//    values are still stale by the time the page loads (could be
//    days), so users briefly saw incorrect numbers pre-hydration.
//
// 3. aperture-pve6 — CSR-time-pinning pattern. SSG renders em-dash
//    placeholders ("—") for every numeric slot + a "carregando"
//    aria-label. Both server and client first-render produce identical
//    DOM, so React hydrates clean — no warning. A useEffect immediately
//    after mount flips `mounted=true` and populates real numbers.
//    Previously then ticked H/MIN/S on a 1Hz setInterval.
//
// 4. aperture-xijyq (THIS PASS) — operator reduced the countdown from
//    4 segments (DIAS · H · MIN · S) to 2 (SEMANAS · DIAS). Per-second
//    ticking was removed entirely: at day-granularity there is nothing
//    to refresh in-session — the value won't change until midnight, and
//    the user will have navigated away long before then. Hydration
//    pattern (placeholder → real on mount) is preserved.

interface CountdownTimerProps {
  /** Target date in ISO format (YYYY-MM-DD). */
  targetISO: string;
}

interface Diff {
  weeks: number;
  days: number;
  done: boolean;
}

function computeDiff(targetMs: number, now: number): Diff {
  const totalDays = Math.max(0, Math.floor((targetMs - now) / 86_400_000));
  const weeks = Math.floor(totalDays / 7);
  const days = totalDays % 7;
  return { weeks, days, done: targetMs - now <= 0 };
}

/** Placeholder rendered during SSG + first client render — em-dash so
 *  the loading state is unambiguous and never reads as "event reached". */
const PLACEHOLDER = "—";

function unitLabel(value: number, singular: string, plural: string): string {
  return value === 1 ? singular : plural;
}

export function CountdownTimer({ targetISO }: CountdownTimerProps) {
  const targetMs = new Date(`${targetISO}T00:00:00`).getTime();
  // `mounted` is the hydration sentinel. SSR renders mounted=false →
  // placeholder em-dashes. Client first render also renders
  // mounted=false (same code path, same initial state) → identical
  // DOM → clean hydration with zero React warnings. useEffect flips
  // it post-mount and populates the real diff. No setInterval — at
  // day-granularity there is nothing to tick within a session.
  const [mounted, setMounted] = useState(false);
  const [diff, setDiff] = useState<Diff>({
    weeks: 0,
    days: 0,
    done: false,
  });

  useEffect(() => {
    // react-hooks/set-state-in-effect flags this — but the
    // mounted=false → mounted=true flip is the WHOLE point of the
    // hydration-safe pattern. The state change MUST happen after the
    // first commit (post-hydration) so SSR HTML and client first
    // render produce identical DOM.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    setDiff(computeDiff(targetMs, Date.now()));
  }, [targetMs]);

  if (mounted && diff.done) {
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 14,
          background: "var(--paper)",
          border: "1px solid var(--line)",
          borderRadius: 22,
          padding: "12px 18px 12px 14px",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-caveat), cursive",
            fontSize: 24,
            color: "var(--coral-pink)",
            transform: "rotate(-2deg)",
            display: "inline-block",
            lineHeight: 1.05,
          }}
        >
          chegou! ♡
        </span>
      </div>
    );
  }

  // Pre-mount: render PLACEHOLDER values + a generic aria-label so
  // SSG HTML and client first-render HTML are byte-identical → clean
  // hydration. Post-mount: render the real diff. No
  // suppressHydrationWarning needed.
  const weeksValue = mounted ? String(diff.weeks) : PLACEHOLDER;
  const daysValue = mounted ? String(diff.days) : PLACEHOLDER;
  const weeksLabel = mounted
    ? unitLabel(diff.weeks, "semana", "semanas")
    : "semanas";
  const daysLabel = mounted
    ? unitLabel(diff.days, "dia", "dias")
    : "dias";
  const ariaLabel = mounted
    ? `Faltam ${diff.weeks} ${weeksLabel} e ${diff.days} ${daysLabel} para o nascimento.`
    : "Contagem regressiva carregando.";

  return (
    <div
      role="timer"
      aria-live="polite"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 14,
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 22,
        padding: "12px 18px 12px 14px",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-caveat), cursive",
          fontSize: 20,
          color: "var(--lilac-deep)",
          transform: "rotate(-2deg)",
          lineHeight: 1.05,
          maxWidth: 90,
          display: "inline-block",
        }}
      >
        chegada
        <br />
        em
      </span>
      {/* aperture-xijyq — two-segment row centered within the remaining
          card width via margin-inline:auto on this inner flex track. */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "center",
          gap: 14,
          marginInline: "auto",
        }}
        aria-hidden="true"
      >
        <CountdownUnit value={weeksValue} label={weeksLabel} large />
        <Separator />
        <CountdownUnit value={daysValue} label={daysLabel} large />
      </div>
    </div>
  );
}

function CountdownUnit({
  value,
  label,
  large,
}: {
  value: number | string;
  label: string;
  large?: boolean;
}) {
  return (
    <div style={{ textAlign: "center", minWidth: 52 }}>
      <div
        style={{
          fontFamily: "var(--font-patrick-hand), cursive",
          fontSize: large ? 38 : 30,
          color: large ? "var(--coral-pink)" : "var(--plum)",
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <span
        style={{
          display: "block",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--ink-mute)",
          marginTop: 4,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function Separator() {
  return (
    <span
      style={{
        fontFamily: "var(--font-patrick-hand), cursive",
        fontSize: 28,
        color: "var(--lilac)",
        lineHeight: 1,
        alignSelf: "center",
      }}
      aria-hidden="true"
    >
      :
    </span>
  );
}
