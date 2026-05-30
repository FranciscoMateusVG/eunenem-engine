import { useRef, type ReactNode } from 'react';
import { useAuthModal } from '@/components/eunenem/auth/AuthModalProvider';

// aperture-b8yn3 — v2 rewrite of section 03 "Como funciona".
// Same 3-step structure + icons + tilted scrapbook tiles as v1, but tighter
// copy per the v2 HTML (data-screen-label="03 Como funciona"): a new sub
// under the heading and shorter step descriptions that explicitly mention
// Pix. Step copy is held inline here (rather than in landing.ts) so the
// v2 surface owns its own words and stays in scope for this PR.
interface Step {
  n: number;
  /** Tailwind bg colour utility for the tile. */
  color: string;
  /** Tailwind rotation utility for the scrapbook tilt. */
  rot: string;
  title: string;
  desc: string;
  icon: ReactNode;
}

const STEPS: ReadonlyArray<Step> = [
  {
    n: 1,
    color: 'bg-pink',
    rot: '-rotate-3',
    title: 'crie sua lista',
    desc: 'Cadastre-se grátis. Use uma lista pronta ou monte do seu jeito.',
    icon: (
      <svg
        viewBox="0 0 56 56"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-14 h-14"
      >
        <rect x="10" y="8" width="32" height="40" rx="3" />
        <path d="M18 20h16M18 28h16M18 36h10" />
        <circle cx="40" cy="14" r="6" fill="#F7D560" stroke="#fff" />
        <path d="M40 11v6M37 14h6" />
      </svg>
    ),
  },
  {
    n: 2,
    color: 'bg-green',
    rot: 'rotate-2',
    title: 'compartilhe',
    desc: 'Envie pelo WhatsApp ou crie um convite digital lindo, com a sua cara.',
    icon: (
      <svg
        viewBox="0 0 56 56"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-14 h-14"
      >
        <circle cx="14" cy="16" r="5" />
        <circle cx="42" cy="10" r="5" />
        <circle cx="42" cy="44" r="5" />
        <path d="M19 18 37 12M19 19 37 41" />
      </svg>
    ),
  },
  {
    n: 3,
    color: 'bg-blue',
    rot: '-rotate-2',
    title: 'receba em dinheiro',
    desc: 'Você saca direto na sua conta via Pix, quando quiser.',
    icon: (
      <svg
        viewBox="0 0 56 56"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-14 h-14"
      >
        <rect x="6" y="14" width="44" height="28" rx="3" />
        <circle cx="28" cy="28" r="6" fill="#F7D560" stroke="#fff" />
        <path d="M11 14V11a3 3 0 0 1 3-3h28a3 3 0 0 1 3 3v3" />
      </svg>
    ),
  },
];

export function HowItWorks() {
  // aperture-nop8l — CTA opens signup modal.
  const auth = useAuthModal();
  const ctaRef = useRef<HTMLButtonElement | null>(null);
  return (
    <section id="como-funciona" className="fade-up py-22 bg-cream">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="text-center max-w-[760px] mx-auto mb-14">
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            é simples assim
          </span>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            em 3 passos,{' '}
            <em className="not-italic text-lilac-deep">seu chá está pronto</em>
          </h2>
          <p className="text-[17px] text-ink-soft mt-3.5 text-pretty">
            Sem burocracia. Você cuida do bebê, a gente cuida do resto.
          </p>
        </div>
        <div className="steps-line relative grid grid-cols-1 lg:grid-cols-3 gap-7">
          {STEPS.map((s) => (
            <div key={s.n} className="relative z-10 text-center px-3 group">
              <div
                className={`relative w-[120px] h-[120px] mx-auto mb-5 rounded-3xl flex items-center justify-center shadow-soft-md transition-transform group-hover:-rotate-6 group-hover:-translate-y-1 ${s.color} ${s.rot}`}
              >
                <span className="absolute -top-3 -right-3 w-9 h-9 rounded-full bg-white text-plum font-display font-semibold text-lg flex items-center justify-center shadow-soft-sm border-2 border-lilac-soft">
                  {s.n}
                </span>
                {s.icon}
              </div>
              <h3 className="font-display text-2xl font-semibold mb-2 text-plum">
                {s.title}
              </h3>
              <p className="text-ink-soft text-[15px] max-w-[280px] mx-auto text-pretty">
                {s.desc}
              </p>
            </div>
          ))}
        </div>
        <div className="text-center mt-14">
          <button
            ref={ctaRef}
            type="button"
            onClick={() => auth.open('signup', ctaRef.current)}
            className="btn-outline"
          >
            começar agora →
          </button>
        </div>
      </div>
    </section>
  );
}
