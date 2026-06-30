'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { InvitePreview } from '@/components/eunenem/painel/ConviteBody';
import type { ConviteState } from '@/lib/mocks/convite';
import { LANDING_INVITE_DEMOS } from '@/lib/mocks/landing';

// aperture-q1j2 — digital-invite gallery.
// 3-column grid on desktop (lg+); horizontal scroll-snap carousel on mobile.
// Previews use real watercolor templates via InvitePreview (same renderer as painel).

const STORY_WIDTH = 400;

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
      className="invites-card aspect-[3/4] rounded-3xl overflow-hidden relative border border-black hover:-translate-y-2 hover:-rotate-1 transition-all cursor-pointer"
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
    const card = track.querySelectorAll<HTMLElement>('.invites-card')[index];
    card?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
    setActiveIndex(index);
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
        >
          {LANDING_INVITE_DEMOS.map((state) => (
            <InviteCard key={state.bgTemplate} state={state} />
          ))}
        </div>

        <div
          className="invites-carousel-dots lg:hidden"
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
