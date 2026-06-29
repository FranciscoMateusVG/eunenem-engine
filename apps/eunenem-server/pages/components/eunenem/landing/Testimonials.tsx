'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LANDING_TESTIMONIALS,
  LANDING_TESTIMONIALS_RATING,
} from '@/lib/mocks/landing';

import { TestiCard } from './TestiCard';

// aperture-q1j2 — testimonial grid with aggregate rating card.
// 3-column grid on desktop (lg+); horizontal scroll-snap carousel on mobile.

export function Testimonials() {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

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

    setActiveIndex(closest);
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    syncActiveFromScroll();
    track.addEventListener('scroll', syncActiveFromScroll, { passive: true });
    return () => track.removeEventListener('scroll', syncActiveFromScroll);
  }, [syncActiveFromScroll]);

  const scrollToCard = (index: number) => {
    const track = trackRef.current;
    if (!track) return;
    const card = track.querySelectorAll<HTMLElement>('.testi-card')[index];
    card?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
    setActiveIndex(index);
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
        >
          {LANDING_TESTIMONIALS.map((t) => (
            <TestiCard key={t.name} {...t} />
          ))}
        </div>

        <div
          className="testi-carousel-dots lg:hidden"
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
