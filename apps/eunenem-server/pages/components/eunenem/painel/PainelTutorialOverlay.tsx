// aperture-7nius — 9-step painel tutorial overlay (hand-rolled spotlight).
//
// Plan 0018 §"Component shape" + §"Visual fidelity gate". No external lib
// (no react-joyride, no shepherd.js) — the painel only has 9 fixed steps
// with brand-specific styling, so a ~5kb hand-rolled implementation pays
// for itself vs ~50kb of library overhead.
//
// How it works:
//
//   1. Step state lives in React (1..9). Initial: 1. Reset to 1 each time
//      the overlay (re-)opens.
//   2. For the current step, we look up the target row via
//        document.querySelector(`[data-tutorial-target="<id>"]`)
//      then read getBoundingClientRect() for the spotlight + popover math.
//   3. The "cutout" is achieved with a box-shadow trick: a small absolutely-
//      positioned ring sits over the target rect with a HUGE outward
//      box-shadow in the dimmed colour. Effect: dim everywhere EXCEPT
//      inside the ring. No SVG mask + no portal complexity — single
//      <div role="dialog"> at the document root.
//   4. The popover sits above or below the target rect, clamped to the
//      viewport so it never overflows the edges. Preferred side comes
//      from the step config (`defaultPosition`), but falls back to the
//      opposite side if there isn't room.
//   5. Re-computed on window resize + scroll (the painel is sticky-topped
//      and scrollable). We also lock body scroll so the user can't
//      scroll the spotlight off-target.
//   6. Keyboard: Escape dismisses; ← / → step.
//
// Mobile: same component, same selectors, popover always picks bottom for
// narrow viewports (≤640px) so it can use the full screen width below the
// target. No separate mobile component.

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  PAINEL_TUTORIAL_STEPS,
  PAINEL_TUTORIAL_TOTAL_STEPS,
} from "./painelTutorialSteps";

interface PainelTutorialOverlayProps {
  /** Controlled — parent renders nothing visual when false. */
  open: boolean;
  /** Fires when the user clicks CONCLUIR on step 9. Parent fires the
   *  completarTutorial mutation + closes the overlay. */
  onComplete: () => void;
  /** Fires when the user clicks ENCERRAR TUTORIAL or presses Escape.
   *  Parent closes the overlay; per plan §"Dismissal path" the mutation
   *  ALSO fires (skip == complete in v1). The parent decides whether to
   *  invoke the mutation. */
  onDismiss: () => void;
}

interface SpotlightRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

// Spotlight ring padding around the target (in px). Gives the ring a
// little breathing room around the row so the highlight doesn't look
// flush against the row's edge.
const RING_PADDING = 6;
// Gap between the ring edge and the popover card.
const POPOVER_GAP = 14;
// Popover width clamp.
const POPOVER_MAX_WIDTH = 360;
// Mobile breakpoint — popover always picks bottom below this.
const MOBILE_BREAKPOINT = 640;
// Viewport edge clamp padding.
const VIEWPORT_PAD = 12;

export function PainelTutorialOverlay({
  open,
  onComplete,
  onDismiss,
}: PainelTutorialOverlayProps) {
  // Step is 1-indexed externally (matches "passo N/9") but we keep
  // 0-indexed internally for array access. We expose it 1-indexed in the
  // UI only.
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  const [viewport, setViewport] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1024,
    h: typeof window !== "undefined" ? window.innerHeight : 768,
  }));

  const step = PAINEL_TUTORIAL_STEPS[stepIdx];
  const isFirst = stepIdx === 0;
  const isLast = stepIdx === PAINEL_TUTORIAL_TOTAL_STEPS - 1;

  // Reset to step 1 each time the overlay (re-)opens.
  useEffect(() => {
    if (open) setStepIdx(0);
  }, [open]);

  // Lock body scroll while open. Restoration handles unmount + close.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Track viewport size (for mobile vs desktop popover placement).
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // Compute spotlight rect from the target DOM node. Re-runs on step
  // change, viewport change, OR scroll (the painel topbar is sticky so
  // scrolling shifts target rects).
  const recompute = useCallback(() => {
    if (!open || !step) return;
    const el = document.querySelector<HTMLElement>(
      `[data-tutorial-target="${step.targetId}"]`,
    );
    if (!el) {
      // Target missing — fall back to a centered "fake" rect so the
      // popover still renders something coherent. This shouldn't fire
      // in production (every step's id matches a painelDemo row) but
      // guards against painel refactors that drop a row.
      setRect(null);
      return;
    }
    // Scroll the target into view if it's off-screen. Only fires when the
    // step changes (the recompute dep on stepIdx via the wrapping
    // effect).
    const r = el.getBoundingClientRect();
    if (r.top < 80 || r.bottom > window.innerHeight - 80) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // After scrolling we re-read on the next animation frame.
      requestAnimationFrame(() => {
        const r2 = el.getBoundingClientRect();
        setRect({
          top: r2.top,
          left: r2.left,
          width: r2.width,
          height: r2.height,
        });
      });
      return;
    }
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [open, step]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute, stepIdx]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => {
      // Quick rect refresh on scroll. Don't trigger the scrollIntoView
      // branch during user scroll — just keep the spotlight pinned.
      if (!step) return;
      const el = document.querySelector<HTMLElement>(
        `[data-tutorial-target="${step.targetId}"]`,
      );
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, step]);

  // Keyboard: Escape dismisses, ← / → step.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (isLast) onComplete();
        else setStepIdx((i) => Math.min(i + 1, PAINEL_TUTORIAL_TOTAL_STEPS - 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (!isFirst) setStepIdx((i) => Math.max(i - 1, 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isFirst, isLast, onComplete, onDismiss]);

  if (!open || !step) return null;

  // Spotlight ring rect — padded around the target. When `rect` is null
  // (target missing) we just dim with no cutout.
  const ringTop = rect ? rect.top - RING_PADDING : 0;
  const ringLeft = rect ? rect.left - RING_PADDING : 0;
  const ringWidth = rect ? rect.width + RING_PADDING * 2 : 0;
  const ringHeight = rect ? rect.height + RING_PADDING * 2 : 0;

  // Popover placement.
  const isMobile = viewport.w <= MOBILE_BREAKPOINT;
  const preferred = isMobile ? "bottom" : step.defaultPosition;
  const popoverWidth = Math.min(POPOVER_MAX_WIDTH, viewport.w - VIEWPORT_PAD * 2);

  // Try preferred side; flip if it would clip. Estimate popover height
  // at ~260px for placement; the actual element auto-sizes.
  const ESTIMATED_POPOVER_HEIGHT = 260;
  let popoverTop: number;
  let popoverPlacement: "top" | "bottom";
  if (rect) {
    if (preferred === "bottom") {
      const wouldFit =
        rect.top + rect.height + POPOVER_GAP + ESTIMATED_POPOVER_HEIGHT <=
        viewport.h - VIEWPORT_PAD;
      if (wouldFit) {
        popoverTop = rect.top + rect.height + POPOVER_GAP;
        popoverPlacement = "bottom";
      } else {
        popoverTop = rect.top - POPOVER_GAP - ESTIMATED_POPOVER_HEIGHT;
        popoverPlacement = "top";
      }
    } else {
      const wouldFit =
        rect.top - POPOVER_GAP - ESTIMATED_POPOVER_HEIGHT >= VIEWPORT_PAD;
      if (wouldFit) {
        popoverTop = rect.top - POPOVER_GAP - ESTIMATED_POPOVER_HEIGHT;
        popoverPlacement = "top";
      } else {
        popoverTop = rect.top + rect.height + POPOVER_GAP;
        popoverPlacement = "bottom";
      }
    }
  } else {
    // Centered fallback.
    popoverTop = Math.max(VIEWPORT_PAD, viewport.h / 2 - ESTIMATED_POPOVER_HEIGHT / 2);
    popoverPlacement = "bottom";
  }
  popoverTop = Math.max(VIEWPORT_PAD, popoverTop);

  // Horizontal centering on the target, clamped to viewport.
  let popoverLeft: number;
  if (rect) {
    const targetCenter = rect.left + rect.width / 2;
    popoverLeft = targetCenter - popoverWidth / 2;
  } else {
    popoverLeft = viewport.w / 2 - popoverWidth / 2;
  }
  popoverLeft = Math.max(
    VIEWPORT_PAD,
    Math.min(popoverLeft, viewport.w - popoverWidth - VIEWPORT_PAD),
  );

  const handleNext = () => {
    if (isLast) onComplete();
    else setStepIdx((i) => Math.min(i + 1, PAINEL_TUTORIAL_TOTAL_STEPS - 1));
  };

  const handleBack = () => {
    if (!isFirst) setStepIdx((i) => Math.max(i - 1, 0));
  };

  return (
    <div
      className="painel-tutorial-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="painel-tutorial-titulo"
    >
      {/* Full-screen dim — sits below the spotlight ring. We use a
       *  separate layer (not the body of the ring's box-shadow alone) so
       *  we can pointer-events:auto here while the ring window passes
       *  clicks through to the page if we ever want it. v1 swallows
       *  clicks everywhere (clean modal semantics). */}
      <div className="painel-tutorial-backdrop" aria-hidden="true" />

      {/* Spotlight ring — only rendered when we have a target rect.
       *  The huge outer box-shadow is the actual dim; the inner border
       *  is the highlight ring around the target. */}
      {rect && (
        <div
          className="painel-tutorial-spotlight"
          aria-hidden="true"
          style={{
            top: `${ringTop}px`,
            left: `${ringLeft}px`,
            width: `${ringWidth}px`,
            height: `${ringHeight}px`,
          }}
        />
      )}

      {/* Top-right ENCERRAR TUTORIAL — plan §"Dismissal path". Sits on
       *  top of the backdrop so it's clickable. */}
      <button
        type="button"
        className="painel-tutorial-encerrar"
        onClick={onDismiss}
      >
        ENCERRAR TUTORIAL
      </button>

      {/* Popover card. Position computed from the target rect. */}
      <div
        className={`painel-tutorial-popover placement-${popoverPlacement}`}
        style={{
          top: `${popoverTop}px`,
          left: `${popoverLeft}px`,
          width: `${popoverWidth}px`,
        }}
      >
        <div className="painel-tutorial-popover-head">
          <span className="painel-tutorial-passo">
            passo {stepIdx + 1}/{PAINEL_TUTORIAL_TOTAL_STEPS}
          </span>
        </div>
        <h3 className="painel-tutorial-titulo" id="painel-tutorial-titulo">
          {step.titulo}
        </h3>
        <p className="painel-tutorial-descricao">{step.descricao}</p>

        <div className="painel-tutorial-dots" aria-hidden="true">
          {PAINEL_TUTORIAL_STEPS.map((s, i) => (
            <span
              key={s.targetId}
              className={`painel-tutorial-dot${i === stepIdx ? " is-active" : ""}`}
            />
          ))}
        </div>

        <div className="painel-tutorial-actions">
          <button
            type="button"
            className="painel-tutorial-back"
            onClick={handleBack}
            disabled={isFirst}
            aria-label="passo anterior"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              width={18}
              height={18}
              aria-hidden="true"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            type="button"
            className="painel-tutorial-next"
            onClick={handleNext}
          >
            {isLast ? "CONCLUIR" : "PRÓXIMO"}
          </button>
        </div>
      </div>
    </div>
  );
}
