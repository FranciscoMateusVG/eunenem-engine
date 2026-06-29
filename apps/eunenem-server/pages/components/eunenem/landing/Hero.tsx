import { useEffect, useRef, useState } from 'react';

import { useAuthModal } from '@/components/eunenem/auth/AuthModalProvider';

// aperture-ospu7 — v2 rewrite of section 01 "Hero" (data-screen-label="01 Hero"
// in EuNenem Landing v2.html). Out goes the hero-bg.jpg page background +
// blob illustration + giant heart-cluster of v1; in comes:
//   - live-badge with daily-counter (animated drift, seed = 27 per v2 HTML)
//   - new headline "Seu chá de bebê do seu jeito" with .hl marca-texto on
//     "chá de bebê" and plum emphasis on "seu jeito" (matches v2 markup)
//   - 3 check-prefixed bullets (Pix in 10 min · 5 min setup · convite grátis)
//   - polaroid + Pix notification card on the right
//   - avatar stack + 5-star rating strip below the CTAs
//
// The hero-bg.jpg asset is still used inside the polaroid photo mask (per v2
// HTML line 126); it is NOT the page background anymore.
//
// CSS additions live in tailwind.css under "aperture-ospu7" — keyframes for
// the polaroid float, plus selectors for the polaroid / tape / photo mask
// / floating cards / counter card that need pseudo-elements + absolute
// positioning utilities don't cleanly express in Tailwind utilities alone.

const LIVE_BADGE_SEED = 27;

export function Hero() {
  // Daily counter: bump slowly (~1 every 45s) so it feels alive without
  // being jarring. SSR-safe — seed renders identically on server + first
  // client paint; the interval kicks in after mount.
  const [liveCount, setLiveCount] = useState(LIVE_BADGE_SEED);
  useEffect(() => {
    const t = window.setInterval(() => {
      setLiveCount((n) => n + 1);
    }, 45_000);
    return () => window.clearInterval(t);
  }, []);

  // aperture-nop8l — CTA opens the signup modal instead of linking out.
  const auth = useAuthModal();
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  return (
    <header className="hero-section relative isolate overflow-hidden bg-cream pt-14 pb-0 lg:pb-20">
      <div className="relative z-10 mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-12 px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
        {/* ===================== COPY (top) ===================== */}
        <div className="text-left lg:col-start-1 lg:row-start-1">
          <span className="hero-live-badge">
            <span className="hero-live-dot" aria-hidden />
            <span>
              <strong>{liveCount} mães</strong> criaram a lista hoje
            </span>
          </span>

          <h1 className="hero-headline mt-5 font-display text-[clamp(40px,5.6vw,64px)] font-semibold leading-[1.02] tracking-tight text-ink text-balance">
            Seu <span className="hl">chá de bebê</span> do{' '}
            <span className="text-plum">seu jeito.</span>
          </h1>

          <p className="mt-5 max-w-[540px] text-[18px] leading-[1.6] text-ink-soft text-pretty">
            Crie a lista grátis em 5 minutos. Convidados presenteiam
            online,{' '}
            <strong className="text-plum font-bold">
              você recebe 100% em dinheiro via Pix
            </strong>{' '}
            e compra o que o bebê{' '}
            <em className="not-italic text-plum font-semibold">realmente</em>{' '}
            precisa.
          </p>
        </div>

        {/* ===================== VISUAL (after intro on mobile) ===================== */}
        <div
          className="hero-visual relative mx-auto w-full max-w-[460px] lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:mx-0"
          aria-hidden
        >
          <div className="hero-polaroid">
            <div className="hero-tape" aria-hidden>
              ♡
            </div>
            <div className="hero-photo" />
          </div>

          {/* Bottom-right Pix notification — overlaps polaroid corner */}
          <div className="hero-fcard hero-fcard--pix">
            <span
              className="hero-av-mini"
              style={{ background: 'var(--green)' }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                width={14}
                height={14}
              >
                <path d="M5 12l5 5L20 7" />
              </svg>
            </span>
            <div>
              <div className="hero-fcard-title">Pix recebido!</div>
              <div className="hero-fcard-meta">
                <strong className="text-plum">R$ 380</strong> · em 8 min
              </div>
            </div>
          </div>
        </div>

        {/* ===================== COPY (bottom) ===================== */}
        <div className="text-left lg:col-start-1 lg:row-start-2">

          <div className="mt-7 flex w-full flex-col items-center gap-4 lg:flex-row lg:flex-wrap lg:items-center lg:justify-start">
            <button
              ref={ctaRef}
              type="button"
              onClick={() => auth.open('signup', ctaRef.current)}
              className="btn-lilac btn-lilac-lg w-full justify-center lg:w-auto"
            >
              → criar minha lista grátis
            </button>
            <a
              href="#calculadora"
              className="text-center text-[14px] font-semibold text-lilac-deep hover:text-plum transition-colors"
            >
              ou simular quanto vou receber →
            </a>
          </div>

          <div className="hero-social mt-8">
            <div className="hero-social-inner">
              <div className="hero-stack flex shrink-0">
                <img
                  src="/public/dep-luciana.jpg"
                  alt=""
                  className="hero-stack-av"
                />
                <img
                  src="/public/dep-janaina.jpg"
                  alt=""
                  className="hero-stack-av"
                />
                <img
                  src="/public/dep-maite.jpg"
                  alt=""
                  className="hero-stack-av"
                />
                <img
                  src="/public/dep-ana-paula.jpg"
                  alt=""
                  className="hero-stack-av"
                />
              </div>
              <div className="hero-social-copy text-[13.5px] text-ink-soft">
                <div
                  className="text-yellow tracking-[1px] text-[13px]"
                  aria-label="Avaliação 4,9 de 5 estrelas"
                >
                  ★★★★★{' '}
                  <strong className="text-plum font-bold">4,9</strong>
                </div>
                <p className="hero-social-tagline">
                  <strong className="text-plum font-bold">+300 mil mães</strong>{' '}
                  com{'\u00a0'}a{'\u00a0'}EuNeném
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile-only stats band (v2 mock §01) */}
      <div className="hero-mobile-stats lg:hidden" aria-label="Números da EuNeném">
        <div className="hero-mobile-stats-grid">
          <HeroMobileStat value="+300mil" label="famílias atendidas" />
          <HeroMobileStat value="12 anos" label="no mercado desde 2014" />
          <HeroMobileStat value="4,9" label="avaliação média" showStar />
          <HeroMobileStat value="R$15M+" label="enviados às famílias" />
        </div>
      </div>
    </header>
  );
}

function HeroMobileStat({
  value,
  label,
  showStar = false,
}: {
  value: string;
  label: string;
  showStar?: boolean;
}) {
  return (
    <div className="hero-mobile-stat">
      <div className="hero-mobile-stat-value">
        {value}
        {showStar ? (
          <span className="hero-mobile-stat-star" aria-hidden>
            ★
          </span>
        ) : null}
      </div>
      <div className="hero-mobile-stat-label">{label}</div>
    </div>
  );
}
