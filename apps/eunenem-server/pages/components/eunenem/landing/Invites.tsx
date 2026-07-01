'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { InvitePreview } from '@/components/eunenem/painel/ConviteBody';
import type { ConviteState } from '@/lib/mocks/convite';
import { LANDING_INVITE_DEMOS } from '@/lib/mocks/landing';

// aperture-q1j2 — digital-invite gallery.
// Infinite horizontal carousel: auto-advance, mouse drag on desktop, native touch scroll on mobile.
// Previews use real watercolor templates via InvitePreview (same renderer as painel).

const STORY_WIDTH = 400;
const INVITE_COUNT = LANDING_INVITE_DEMOS.length;
const LOOPED_INVITES = [...LANDING_INVITE_DEMOS, ...LANDING_INVITE_DEMOS];
const AUTO_SCROLL_MS = 4000;
const RESUME_AUTO_SCROLL_MS = 5000;

function InviteCard({ state }: { state: ConviteState }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.85);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    const updateScale = () => {
      setScale(el.clientWidth / STORY_WIDTH);
    };

    updateScale();
    const ro = new ResizeObserver(updateScale);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={cardRef}
      className="invites-card aspect-[3/4] rounded-3xl overflow-hidden relative shadow-soft-md hover:shadow-soft-md hover:-translate-y-2 hover:-rotate-1 transition-all"
    >
      <InvitePreview
        state={state}
        format="story"
        fidelity="scrapbook"
        scale={scale}
      />
    </div>
  );
}

export function Invites() {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);
  const isMouseDragging = useRef(false);
  const isTouching = useRef(false);
  const dragStartX = useRef(0);
  const dragStartScroll = useRef(0);
  const isPaused = useRef(false);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollSyncRaf = useRef<number | null>(null);
  const scrollSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pauseAutoScroll = useCallback(() => {
    isPaused.current = true;
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
  }, []);

  const scheduleResumeAutoScroll = useCallback(() => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => {
      isPaused.current = false;
    }, RESUME_AUTO_SCROLL_MS);
  }, []);

  const normalizeLoop = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const half = track.scrollWidth / 2;
    if (half <= 0) return;

    if (track.scrollLeft >= half) {
      const prev = track.style.scrollBehavior;
      track.style.scrollBehavior = 'auto';
      track.scrollLeft -= half;
      track.style.scrollBehavior = prev;
    } else if (track.scrollLeft < 0) {
      const prev = track.style.scrollBehavior;
      track.style.scrollBehavior = 'auto';
      track.scrollLeft += half;
      track.style.scrollBehavior = prev;
    }
  }, []);

  const syncActiveFromScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const cards = track.querySelectorAll<HTMLElement>('.invites-card');
    if (cards.length === 0) return;

    const center = track.scrollLeft + track.clientWidth / 2;
    let closest = 0;
    let minDist = Number.POSITIVE_INFINITY;

    cards.forEach((card, i) => {
      const cardCenter = card.offsetLeft + card.offsetWidth / 2;
      const dist = Math.abs(center - cardCenter);
      if (dist < minDist) {
        minDist = dist;
        closest = i;
      }
    });

    const next = closest % INVITE_COUNT;
    if (next === activeIndexRef.current) return;
    activeIndexRef.current = next;
    setActiveIndex(next);
  }, []);

  const finalizeScroll = useCallback(() => {
    normalizeLoop();
    syncActiveFromScroll();
  }, [normalizeLoop, syncActiveFromScroll]);

  const scheduleActiveSync = useCallback(() => {
    if (scrollSyncRaf.current !== null) return;
    scrollSyncRaf.current = requestAnimationFrame(() => {
      scrollSyncRaf.current = null;
      syncActiveFromScroll();
    });
  }, [syncActiveFromScroll]);

  const advanceOneCard = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const card = track.querySelector<HTMLElement>('.invites-card');
    if (!card) return;
    const gap = Number.parseFloat(getComputedStyle(track).gap) || 24;
    track.scrollBy({ left: card.offsetWidth + gap, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const onScroll = () => {
      const half = track.scrollWidth / 2;
      // During touch or mouse drag, let the browser own scrolling; normalize after release.
      if (
        !isTouching.current &&
        !isMouseDragging.current &&
        half > 0 &&
        track.scrollLeft >= half
      ) {
        normalizeLoop();
      }

      scheduleActiveSync();

      if (scrollSettleTimer.current) clearTimeout(scrollSettleTimer.current);
      scrollSettleTimer.current = setTimeout(finalizeScroll, 120);
    };

    finalizeScroll();
    track.addEventListener('scroll', onScroll, { passive: true });
    track.addEventListener('scrollend', finalizeScroll, { passive: true });
    return () => {
      track.removeEventListener('scroll', onScroll);
      track.removeEventListener('scrollend', finalizeScroll);
      if (scrollSettleTimer.current) clearTimeout(scrollSettleTimer.current);
      if (scrollSyncRaf.current !== null) {
        cancelAnimationFrame(scrollSyncRaf.current);
      }
    };
  }, [finalizeScroll, normalizeLoop, scheduleActiveSync]);

  useEffect(() => {
    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (prefersReduced) return;

    const id = setInterval(() => {
      if (isPaused.current || isMouseDragging.current || isTouching.current) {
        return;
      }
      advanceOneCard();
    }, AUTO_SCROLL_MS);

    return () => clearInterval(id);
  }, [advanceOneCard]);

  useEffect(
    () => () => {
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      if (scrollSettleTimer.current) clearTimeout(scrollSettleTimer.current);
      if (scrollSyncRaf.current !== null) {
        cancelAnimationFrame(scrollSyncRaf.current);
      }
    },
    [],
  );

  const scrollToCard = (index: number) => {
    const track = trackRef.current;
    if (!track) return;
    pauseAutoScroll();
    const card = track.querySelectorAll<HTMLElement>('.invites-card')[index];
    card?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
    setActiveIndex(index);
    activeIndexRef.current = index;
    scheduleResumeAutoScroll();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const track = trackRef.current;
    if (!track) return;

    if (e.pointerType === 'touch') {
      isTouching.current = true;
      pauseAutoScroll();
      return;
    }

    if (e.pointerType !== 'mouse') return;

    isMouseDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartScroll.current = track.scrollLeft;
    track.setPointerCapture(e.pointerId);
    track.classList.add('is-dragging');
    pauseAutoScroll();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isMouseDragging.current || e.pointerType !== 'mouse') return;
    const track = trackRef.current;
    if (!track) return;
    track.scrollLeft = dragStartScroll.current - (e.clientX - dragStartX.current);
    const before = track.scrollLeft;
    normalizeLoop();
    dragStartScroll.current += track.scrollLeft - before;
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      if (!isTouching.current) return;
      isTouching.current = false;
      finalizeScroll();
      scheduleResumeAutoScroll();
      return;
    }

    if (!isMouseDragging.current) return;
    const track = trackRef.current;
    if (!track) return;

    isMouseDragging.current = false;
    track.classList.remove('is-dragging');
    if (track.hasPointerCapture(e.pointerId)) {
      track.releasePointerCapture(e.pointerId);
    }
    finalizeScroll();
    scheduleResumeAutoScroll();
  };

  return (
    <section id="convites" className="fade-up py-22 bg-cream">
      <div className="invites-inner mx-auto max-w-[1200px] px-6">
        <div className="invites-header text-center max-w-[760px] mx-auto mb-14">
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            convites digitais grátis
          </span>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            um convite{' '}
            <em className="not-italic text-lilac-deep">lindo</em>, em minutos
          </h2>
        </div>

        <div
          ref={trackRef}
          className="invites-grid invites-carousel-track mb-10 lg:mb-10"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onMouseEnter={pauseAutoScroll}
          onMouseLeave={scheduleResumeAutoScroll}
        >
          {LOOPED_INVITES.map((state, i) => (
            <InviteCard
              key={`${state.bgTemplate}-${i}`}
              state={state}
            />
          ))}
        </div>

        <div
          className="invites-carousel-dots"
          aria-label="Navegação dos convites"
        >
          {LANDING_INVITE_DEMOS.map((_, i) => (
            <button
              key={i}
              type="button"
              className={`invites-carousel-dot${activeIndex === i ? ' is-active' : ''}`}
              aria-label={`Convite ${i + 1}`}
              aria-current={activeIndex === i ? 'true' : undefined}
              onClick={() => scrollToCard(i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
