import type { ReactNode } from 'react';
import { LANDING_LINKS, LANDING_STEPS } from '@/lib/mocks/landing';

// aperture-q1j2 — "em 3 passos" flow with a dashed connector line.
// Step copy lives in the mock; the per-step icon SVGs stay here.
const STEP_ICONS: ReactNode[] = [
  <svg
    key="1"
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
  </svg>,
  <svg
    key="2"
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
  </svg>,
  <svg
    key="3"
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
  </svg>,
];

export function HowItWorks() {
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
            Sem burocracia, sem cartão de crédito, sem complicação. Você cuida do
            bebê — a gente cuida do resto.
          </p>
        </div>
        <div className="steps-line relative grid grid-cols-1 lg:grid-cols-3 gap-7">
          {LANDING_STEPS.map((s, i) => (
            <div key={s.n} className="relative z-10 text-center px-3 group">
              <div
                className={`relative w-[120px] h-[120px] mx-auto mb-5 rounded-3xl flex items-center justify-center shadow-soft-md transition-transform group-hover:-rotate-6 group-hover:-translate-y-1 ${s.color} ${s.rot}`}
              >
                <span className="absolute -top-3 -right-3 w-9 h-9 rounded-full bg-white text-plum font-display font-semibold text-lg flex items-center justify-center shadow-soft-sm border-2 border-lilac-soft">
                  {s.n}
                </span>
                {STEP_ICONS[i]}
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
          <a href={LANDING_LINKS.criarLista} className="btn-outline">
            começar agora →
          </a>
        </div>
      </div>
    </section>
  );
}
