import { useCallback, useEffect, useRef, useState } from 'react';

// aperture-hsm41 — v2 §04 Diferenciais
// 5-card bento on desktop (lg+); horizontal scroll-snap carousel on mobile.
// Bespoke layout in tailwind.css under /* aperture-hsm41 */.

const CARD_COUNT = 5;

export function Differential() {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const syncActiveFromScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const cards = track.querySelectorAll<HTMLElement>('.diff-card');
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
    const card = track.querySelectorAll<HTMLElement>('.diff-card')[index];
    card?.scrollIntoView({
      behavior: 'smooth',
      inline: 'center',
      block: 'nearest',
    });
    setActiveIndex(index);
  };

  return (
    <section
      id="diferenciais"
      className="diff-section fade-up py-22 overflow-hidden bg-lilac-soft"
    >
      <div className="diff-inner relative z-10 mx-auto max-w-[1200px] px-6">
        <div className="diff-header mb-10 max-w-[760px] text-left lg:mb-14">
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            por que escolher
          </span>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            o que <em className="not-italic text-lilac-deep">só a gente</em> faz
            por você
          </h2>
        </div>

        <div ref={trackRef} className="diff-grid diff-carousel-track">
          {/* 1. HERO — taxa */}
          <div className="diff-card diff-hero">
            <span className="diff-tag">menor taxa do mercado</span>
            <h3 className="font-display">7,8% — e você ainda recebe 100%</h3>
            <div className="diff-hero-row">
              <div className="diff-num font-display">
                7,8<small>%</small>
              </div>
            </div>
            <p>
              Concorrentes cobram 8% a 12% — convidado paga a taxa e você
              recebe 100% do valor do presente.
            </p>
          </div>

          {/* 2. Pioneira 2014 */}
          <div className="diff-card diff-since">
            <div className="diff-icon c2">
              <svg
                viewBox="0 0 32 32"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 14c0-6 5-10 10-10s10 4 10 10v6l3 4H3l3-4v-6z" />
                <path d="M13 28a3 3 0 006 0" />
              </svg>
            </div>
            <span className="diff-eyebrow">pioneira</span>
            <h3 className="font-display">no ar desde 2014</h3>
            <p>
              Mais de uma década cuidando do enxoval de +300mil bebês.
            </p>
          </div>

          {/* 3. Multimoedas */}
          <div className="diff-card diff-world">
            <div className="diff-icon c3">
              <svg
                viewBox="0 0 32 32"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="16" cy="16" r="11" />
                <path d="M5 16h22" />
                <path d="M16 5a11 11 0 0 1 3.67 11 11 11 0 0 1-3.67 11 11 11 0 0 1-3.67-11 11 11 0 0 1 3.67-11z" />
              </svg>
            </div>
            <span className="diff-eyebrow">único no Brasil</span>
            <h3 className="font-display">família no exterior? sem problema</h3>
            <p>
              USD, EUR, GBP, JPY. Convidado paga na moeda dele, você recebe em
              real.
            </p>
          </div>

          {/* 4. Sem taxa de resgate */}
          <div className="diff-card diff-no-fee">
            <div className="diff-icon c1">
              <svg
                viewBox="0 0 32 32"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="4" y="9" width="24" height="16" rx="2" />
                <circle cx="16" cy="17" r="3.5" />
                <path d="M8 14h2M22 14h2M8 22h2M22 22h2" />
              </svg>
            </div>
            <span className="diff-eyebrow">resgate</span>
            <h3 className="font-display">saque ilimitado, taxa zero</h3>
            <p>
              Receba via Pix. Quantos saques quiser, sem custo.
            </p>
          </div>

          {/* 5. Suporte humano */}
          <div className="diff-card diff-support">
            <div className="diff-icon c4">
              <svg
                viewBox="0 0 32 32"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 19c0-6 4-11 10-11s10 5 10 11v3a3 3 0 01-3 3h-2v-7h5" />
                <path d="M6 22v-7h5v7H8a2 2 0 01-2-2z" />
              </svg>
            </div>
            <span className="diff-eyebrow">atendimento</span>
            <h3 className="font-display">gente de verdade no WhatsApp</h3>
            <p>
              Convidado não conseguiu pagar? Manda mensagem — quem responde é
              gente.
            </p>
          </div>
        </div>

        <div
          className="diff-carousel-dots lg:hidden"
          role="tablist"
          aria-label="Diferenciais"
        >
          {Array.from({ length: CARD_COUNT }, (_, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={activeIndex === i}
              aria-label={`Diferencial ${i + 1} de ${CARD_COUNT}`}
              className={`diff-carousel-dot${activeIndex === i ? ' is-active' : ''}`}
              onClick={() => scrollToCard(i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
