
import { useEffect, useState } from "react";

// aperture-3d9t / aperture-yv2v / aperture-pve6 — countdown to baby's
// expected arrival date. Client component; ticks every second.
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
// 3. aperture-pve6 (THIS PASS) — CSR-time-pinning pattern. SSG renders
//    em-dash placeholders ("—") for every numeric slot + a
//    "carregando" aria-label. Both server and client first-render
//    produce identical DOM, so React hydrates clean — no warning. A
//    useEffect immediately after mount flips `mounted=true` and
//    populates real numbers, swapping seamlessly to the live count-
//    down. Em-dash is the right placeholder vs 0: it unambiguously
//    communicates "loading", not "event reached".

interface CountdownTimerProps {
  /** Target date in ISO format (YYYY-MM-DD). */
  targetISO: string;
}

interface Diff {
  days: number;
  hours: number;
  mins: number;
  secs: number;
  done: boolean;
}

function computeDiff(targetMs: number, now: number): Diff {
  const diff = Math.max(0, targetMs - now);
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  const secs = Math.floor((diff % 60_000) / 1_000);
  return { days, hours, mins, secs, done: diff === 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Placeholder rendered during SSG + first client render — em-dash so
 *  the loading state is unambiguous and never reads as "event reached". */
const PLACEHOLDER = "—";

export function CountdownTimer({ targetISO }: CountdownTimerProps) {
  const targetMs = new Date(`${targetISO}T00:00:00`).getTime();
  // `mounted` is the hydration sentinel. SSR renders mounted=false →
  // placeholder em-dashes. Client first render also renders
  // mounted=false (same code path, same initial state) → identical
  // DOM → clean hydration with zero React warnings. useEffect flips
  // it post-mount and populates the real diff.
  const [mounted, setMounted] = useState(false);
  const [diff, setDiff] = useState<Diff>({
    days: 0,
    hours: 0,
    mins: 0,
    secs: 0,
    done: false,
  });

  useEffect(() => {
    // react-hooks/set-state-in-effect flags this — but the
    // mounted=false → mounted=true flip is the WHOLE point of the
    // hydration-safe pattern. The state change MUST happen after the
    // first commit (post-hydration) so SSR HTML and client first
    // render produce identical DOM. The setDiff() call seeds the
    // real countdown value at mount; the setInterval ticks it 1Hz
    // thereafter.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    setDiff(computeDiff(targetMs, Date.now()));
    const id = setInterval(() => {
      setDiff(computeDiff(targetMs, Date.now()));
    }, 1000);
    return () => clearInterval(id);
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
  const days = mounted ? String(diff.days) : PLACEHOLDER;
  const hours = mounted ? pad(diff.hours) : PLACEHOLDER;
  const mins = mounted ? pad(diff.mins) : PLACEHOLDER;
  const secs = mounted ? pad(diff.secs) : PLACEHOLDER;
  const ariaLabel = mounted
    ? `Faltam ${diff.days} dias, ${diff.hours} horas, ${diff.mins} minutos e ${diff.secs} segundos para o nascimento.`
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
      <div
        style={{ display: "flex", alignItems: "baseline", gap: 10 }}
        aria-hidden="true"
      >
        <CountdownUnit value={days} label="dias" large />
        <Separator />
        <CountdownUnit value={hours} label="h" />
        <Separator />
        <CountdownUnit value={mins} label="min" />
        <Separator />
        <CountdownUnit value={secs} label="s" />
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
    <div style={{ textAlign: "center", minWidth: 38 }}>
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
