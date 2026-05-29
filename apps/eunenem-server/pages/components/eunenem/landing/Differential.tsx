import type { ReactNode } from 'react';
import { LANDING_DIFFERENTIALS } from '@/lib/mocks/landing';

// aperture-q1j2 — "por que dinheiro é melhor" 3-card section on a
// pink→lilac gradient. Card copy lives in the mock; icon SVGs (whose
// stroke must match the chip contrast) stay here, indexed by position.
const DIFF_ICONS: ReactNode[] = [
  <svg
    key="0"
    viewBox="0 0 32 32"
    fill="none"
    stroke="#fff"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-8 h-8"
  >
    <path d="M5 8h3l3 14h14l2.5-10H10" />
    <circle cx="13" cy="26" r="2" />
    <circle cx="22" cy="26" r="2" />
  </svg>,
  <svg
    key="1"
    viewBox="0 0 32 32"
    fill="none"
    stroke="#5C3A4F"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-8 h-8"
  >
    <rect x="8" y="3" width="16" height="26" rx="3" />
    <path d="M14 25h4" />
    <circle cx="22" cy="6" r="2.5" fill="#E78FA7" stroke="none" />
  </svg>,
  <svg
    key="2"
    viewBox="0 0 32 32"
    fill="none"
    stroke="#fff"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-8 h-8"
  >
    <rect x="3" y="9" width="26" height="16" rx="2" />
    <circle cx="16" cy="17" r="4" fill="#F7D560" stroke="#fff" />
  </svg>,
];

export function Differential() {
  return (
    <section
      id="diferencial"
      className="fade-up py-22 overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #FBE0EA 0%, #E8D5F0 100%)' }}
    >
      <div className="mx-auto max-w-[1200px] px-6 relative z-10">
        <div className="text-center max-w-[760px] mx-auto mb-14">
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            o diferencial
          </span>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            por que receber em{' '}
            <em className="not-italic text-lilac-deep">dinheiro</em> é melhor?
          </h2>
          <p className="text-[17px] text-ink-soft mt-3.5 text-pretty">
            Porque cada bebê é único — e quem decide o que ele precisa é você.
          </p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {LANDING_DIFFERENTIALS.map((c, i) => (
            <div
              key={i}
              className="bg-white rounded-3xl p-8 shadow-soft-sm hover:shadow-soft-md hover:-translate-y-1.5 transition-all"
            >
              <div
                className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-5 ${c.bg}`}
              >
                {DIFF_ICONS[i]}
              </div>
              <h3 className="font-display text-[22px] font-semibold text-plum mb-2 leading-tight">
                {c.title}
              </h3>
              <p className="text-ink-soft text-[15px] text-pretty">{c.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
