import { useEffect, useState } from 'react';

import { LANDING_LINKS } from '@/lib/mocks/landing';

// aperture-ospu7 — v2 rewrite of section 01 "Hero" (data-screen-label="01 Hero"
// in EuNenem Landing v2.html). Out goes the hero-bg.jpg page background +
// blob illustration + giant heart-cluster of v1; in comes:
//   - live-badge with daily-counter (animated drift, seed = 27 per v2 HTML)
//   - new headline "Seu chá de bebê do seu jeito" with .hl marca-texto on
//     "chá de bebê" and plum emphasis on "seu jeito" (matches v2 markup)
//   - 3 check-prefixed bullets (Pix in 10 min · 5 min setup · convite grátis)
//   - polaroid + floating cards + counter card on the right
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

  return (
    <header className="hero-section relative isolate overflow-hidden bg-cream pt-14 pb-20">
      <div className="relative z-10 mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-12 px-6 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
        {/* ===================== LEFT: COPY ===================== */}
        <div className="text-center lg:text-left">
          <span className="hero-live-badge">
            <span className="hero-live-dot" aria-hidden />
            <span>
              <strong>{liveCount} mães</strong> criaram a lista hoje
            </span>
          </span>

          <h1 className="hero-headline mt-5 font-display text-[clamp(40px,5.6vw,64px)] font-semibold leading-[1.02] tracking-tight text-ink text-balance">
            Seu <span className="hl">chá de bebê</span> do{' '}
            <span className="text-plum">seu jeito</span> — sem catálogo, sem
            fila, sem repetir presente.
          </h1>

          <p className="mt-5 max-w-[540px] text-[18px] leading-[1.6] text-ink-soft text-pretty mx-auto lg:mx-0">
            Crie a lista grátis em 5 minutos. Seus convidados presenteiam
            online,{' '}
            <strong className="text-plum font-bold">
              você recebe 100% em dinheiro via Pix
            </strong>{' '}
            e compra o que o bebê{' '}
            <em className="not-italic text-plum font-semibold">realmente</em>{' '}
            precisa.
          </p>

          <ul className="hero-bullets mt-6 flex flex-col gap-2.5 text-left">
            <HeroBullet>
              Lista pronta em{' '}
              <strong className="text-plum">menos de 5 minutos</strong>
            </HeroBullet>
            <HeroBullet>
              Pix na conta em <strong className="text-plum">10 minutos</strong>
              , sem taxa de saque
            </HeroBullet>
            <HeroBullet>
              Convite digital + confirmação de presença{' '}
              <strong className="text-plum">grátis</strong>
            </HeroBullet>
          </ul>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
            <a
              href={LANDING_LINKS.criarLista}
              className="btn-lilac btn-lilac-lg"
            >
              → criar minha lista grátis
            </a>
            <a
              href="#calculadora"
              className="text-[14px] font-semibold text-lilac-deep hover:text-plum transition-colors"
            >
              ou simular quanto vou receber →
            </a>
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3.5 lg:justify-start">
            <div className="hero-stack flex">
              <img
                src="/dep-luciana.jpg"
                alt=""
                className="hero-stack-av"
              />
              <img
                src="/dep-janaina.jpg"
                alt=""
                className="hero-stack-av"
              />
              <img
                src="/dep-maite.jpg"
                alt=""
                className="hero-stack-av"
              />
              <img
                src="/dep-ana-paula.jpg"
                alt=""
                className="hero-stack-av"
              />
            </div>
            <div className="text-[13.5px] text-ink-soft">
              <div
                className="text-yellow tracking-[1px] text-[13px]"
                aria-label="Avaliação 4,9 de 5 estrelas"
              >
                ★★★★★{' '}
                <strong className="text-plum font-bold">4,9</strong>
                <span className="text-ink-soft"> de 5</span>
              </div>
              <div>
                <strong className="text-plum font-bold">
                  +300 mil famílias
                </strong>{' '}
                já celebraram com a EuNeném
              </div>
            </div>
          </div>
        </div>

        {/* ===================== RIGHT: VISUAL ===================== */}
        <div
          className="hero-visual relative mx-auto w-full max-w-[460px]"
          aria-hidden
        >
          <div className="hero-polaroid">
            <div className="hero-tape" aria-hidden>
              ♡
            </div>
            <div className="hero-photo" />
          </div>

          {/* Top-right floating card — "Ana presenteou" */}
          <div className="hero-fcard hero-fcard--top">
            <span
              className="hero-av-mini"
              style={{ background: 'var(--lilac-deep)' }}
            >
              A
            </span>
            <div>
              <div className="hero-fcard-title">Ana presenteou ✿</div>
              <div className="hero-fcard-meta">
                há 2 min ·{' '}
                <strong className="text-plum">R$ 150</strong>
              </div>
            </div>
          </div>

          {/* Mid-left floating card — Pix recebido */}
          <div className="hero-fcard hero-fcard--mid">
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

          {/* Bottom-right counter card */}
          <div className="hero-counter hero-fcard--bot">
            <div className="hero-counter-label">presentes hoje</div>
            <div className="hero-counter-num">+1.847</div>
            <div className="hero-counter-meta">
              <span className="hero-counter-up">↑ 12%</span> vs ontem
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function HeroBullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2.5 text-[14.5px] text-ink-soft">
      <span className="hero-check">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          width={12}
          height={12}
        >
          <path d="M5 12l5 5L20 7" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  );
}
