'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LANDING_TESTIMONIALS,
  LANDING_TESTIMONIALS_RATING,
} from '@/lib/mocks/landing';

import { TestiCard } from './TestiCard';

// aperture-q1j2 — testimonial carousel with aggregate rating card.
// Horizontal scroll-snap carousel; mouse drag on desktop, native touch scroll on mobile.

export function Testimonials() {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);
  const isMouseDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartScroll = useRef(0);
  const scrollSyncRaf = useRef<number | null>(null);

  const syncActiveFromScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const cards = track.querySelectorAll<HTMLElement>('.testi-card');
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

    if (closest === activeIndexRef.current) return;
    activeIndexRef.current = closest;
    setActiveIndex(closest);
  }, []);

  const scheduleActiveSync = useCallback(() => {
    if (scrollSyncRaf.current !== null) return;
    scrollSyncRaf.current = requestAnimationFrame(() => {
      scrollSyncRaf.current = null;
      syncActiveFromScroll();
    });
  }, [syncActiveFromScroll]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    syncActiveFromScroll();
    track.addEventListener('scroll', scheduleActiveSync, { passive: true });
    track.addEventListener('scrollend', syncActiveFromScroll, { passive: true });
    return () => {
      track.removeEventListener('scroll', scheduleActiveSync);
      track.removeEventListener('scrollend', syncActiveFromScroll);
      if (scrollSyncRaf.current !== null) {
        cancelAnimationFrame(scrollSyncRaf.current);
      }
    };
  }, [scheduleActiveSync, syncActiveFromScroll]);

  const scrollToCard = (index: number) => {
    const track = trackRef.current;
    if (!track) return;
    const card = track.querySelectorAll<HTMLElement>('.testi-card')[index];
    card?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
    activeIndexRef.current = index;
    setActiveIndex(index);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.pointerType !== 'mouse') return;
    const track = trackRef.current;
    if (!track) return;

    isMouseDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartScroll.current = track.scrollLeft;
    track.setPointerCapture(e.pointerId);
    track.classList.add('is-dragging');
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isMouseDragging.current || e.pointerType !== 'mouse') return;
    const track = trackRef.current;
    if (!track) return;
    track.scrollLeft = dragStartScroll.current - (e.clientX - dragStartX.current);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isMouseDragging.current || e.pointerType !== 'mouse') return;
    const track = trackRef.current;
    if (!track) return;

    isMouseDragging.current = false;
    track.classList.remove('is-dragging');
    if (track.hasPointerCapture(e.pointerId)) {
      track.releasePointerCapture(e.pointerId);
    }
    syncActiveFromScroll();
  };

  return (
    <section id="depoimentos" className="fade-up py-22 bg-cream">
      <div className="testi-inner mx-auto max-w-[1200px] px-6">
        <div className="testi-header text-center max-w-[760px] mx-auto mb-10 lg:mb-14">
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            deixa as{' '}
            <em className="not-italic text-lilac-deep">mães e pais</em> contarem
          </h2>
        </div>

        <div className="testi-rating-card">
          <div className="testi-rating-score">
            {LANDING_TESTIMONIALS_RATING.score}
          </div>
          <div className="testi-rating-meta">
            <div
              className="testi-rating-stars text-yellow tracking-[2px] text-sm"
              aria-hidden="true"
            >
              ★★★★★
            </div>
            <div className="testi-rating-count">
              {LANDING_TESTIMONIALS_RATING.countLabel}
            </div>
            <div className="testi-rating-sub">
              {LANDING_TESTIMONIALS_RATING.fiveStarLabel}
            </div>
          </div>
        </div>

        <div
          ref={trackRef}
          className="testi-grid testi-carousel-track"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {LANDING_TESTIMONIALS.map((t) => (
            <TestiCard key={t.name} {...t} />
          ))}
        </div>

        <div
          className="testi-carousel-dots"
          aria-label="Navegação dos depoimentos"
        >
          {LANDING_TESTIMONIALS.map((t, i) => (
            <button
              key={t.name}
              type="button"
              className={`testi-carousel-dot${activeIndex === i ? ' is-active' : ''}`}
              aria-label={`Depoimento ${i + 1}`}
              aria-current={activeIndex === i ? 'true' : undefined}
              onClick={() => scrollToCard(i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
