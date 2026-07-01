'use client';

import { useMemo, useRef, useState, type CSSProperties } from 'react';

import { useAuthModal } from '@/components/eunenem/auth/AuthModalProvider';

// aperture-5mgiw — Section 05 (Calculadora) of the v2 landing.
// Interactive two-slider income calculator: guests x ticket = total
// the creator nets (EuNeném is "100% em dinheiro", so the 7,5% fee
// is paid by the guest at checkout and the displayed total is what
// the creator actually receives).
//
// Defaults + ranges are mirrored from the v2 HTML prototype so this
// matches the operator-approved spec exactly. Sliders are native
// <input type="range"> styled via .calculadora-* CSS in tailwind.css;
// fill % is passed through a --pct CSS variable on inline style so
// the gradient track tracks the thumb without a JS-driven background.

const TICKET_PRESETS = [60, 120, 200, 350] as const;

// Rough Brazilian averages used for the "compra com isso" callouts.
// Tunable here — copied verbatim from the v2 prototype so behaviour
// matches the approved mock. Source comment lives next to the values.
const BUYS_REFERENCE = {
  // Premium fralda descartável: ~R$ 250 / mês
  diaperMonthlyCost: 250,
  // Fórmula infantil: ~R$ 80 / lata
  milkCanCost: 80,
  // Berço + colchão: ~R$ 1.800
  cribCost: 1800,
  // Carrinho top de linha: ~R$ 3.500
  strollerCost: 3500,
} as const;

function pluralize(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function Calculadora() {
  const [guests, setGuests] = useState<number>(40);
  const [ticket, setTicket] = useState<number>(120);

  // aperture-nop8l — CTA opens signup modal.
  const auth = useAuthModal();
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  // BRL formatter — Brazilian thousands/decimals, R$ prefix.
  // Whole-real granularity (no centavos) because the ticket slider
  // steps in R$ 10 increments anyway, and the result reads cleaner.
  const brl = useMemo(
    () =>
      new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
      }),
    [],
  );

  // === Core derivation =====================================
  // total = guests x ticket. The 7,5% platform fee is paid by the
  // guest on top of the gift, so the creator's payout equals the
  // displayed total. If/when the fee model changes, edit here.
  const total = useMemo(() => guests * ticket, [guests, ticket]);

  const buys = useMemo(() => {
    const diaperMonths = Math.max(
      1,
      Math.round(total / BUYS_REFERENCE.diaperMonthlyCost),
    );
    const milkCans = Math.max(
      1,
      Math.round(total / BUYS_REFERENCE.milkCanCost),
    );
    const cribsFloat = total / BUYS_REFERENCE.cribCost;
    const cribsWhole = Math.floor(cribsFloat);
    const strollersFloat = total / BUYS_REFERENCE.strollerCost;
    const strollersWhole = Math.floor(strollersFloat);

    return {
      diapers: pluralize(diaperMonths, 'mês', 'meses'),
      milk: pluralize(milkCans, 'lata', 'latas'),
      crib:
        cribsWhole >= 1
          ? pluralize(cribsWhole, 'berço', 'berços')
          : `${Math.round(cribsFloat * 100)}%`,
      stroller:
        strollersWhole >= 1
          ? pluralize(strollersWhole, 'carrinho', 'carrinhos')
          : `${Math.round(strollersFloat * 100)}%`,
    };
  }, [total]);

  // Slider fill percentages → pushed to CSS via --pct so the linear-
  // gradient track fills correctly without re-rendering the DOM.
  const guestsPct = ((guests - 10) / (150 - 10)) * 100;
  const ticketPct = ((ticket - 30) / (500 - 30)) * 100;

  const guestsStyle = { '--pct': `${guestsPct}%` } as CSSProperties;
  const ticketStyle = { '--pct': `${ticketPct}%` } as CSSProperties;

  const totalLabel = brl.format(total);
  const ticketLabel = brl.format(ticket);

  return (
    <section
      id="calculadora"
      className="calculadora-section fade-up py-22 overflow-hidden"
    >
      <div className="mx-auto max-w-[1200px] px-6 relative z-10">
        <div className="text-center max-w-[760px] mx-auto mb-14">
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            faça as contas (vai gostar)
          </span>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            quanto seu chá pode{' '}
            <em className="not-italic text-lilac-deep">render</em>?
          </h2>
        </div>

        <div className="calculadora-card">
          {/* ─── Controls ─────────────────────────────────────── */}
          <div className="calculadora-controls">
            <div>
              <div className="calculadora-slider-row">
                <span className="calculadora-slider-label">
                  convidados
                </span>
                <span className="calculadora-slider-value">{guests}</span>
              </div>
              <input
                type="range"
                min={10}
                max={150}
                step={1}
                value={guests}
                onChange={(e) => setGuests(parseInt(e.target.value, 10))}
                className="calculadora-slider"
                style={guestsStyle}
                aria-label="Número de convidados que presenteiam"
              />
            </div>

            <div>
              <div className="calculadora-slider-row">
                <span className="calculadora-slider-label">
                  ticket médio
                </span>
                <span className="calculadora-slider-value">{ticketLabel}</span>
              </div>
              <input
                type="range"
                min={30}
                max={500}
                step={10}
                value={ticket}
                onChange={(e) => setTicket(parseInt(e.target.value, 10))}
                className="calculadora-slider"
                style={ticketStyle}
                aria-label="Valor médio do presente"
              />
              <div className="calculadora-presets">
                {TICKET_PRESETS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setTicket(v)}
                    className={`calculadora-preset${
                      ticket === v ? ' calculadora-preset--active' : ''
                    }`}
                    aria-pressed={ticket === v}
                  >
                    {brl.format(v)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ─── Result ───────────────────────────────────────── */}
          <div className="calculadora-result">
            <span className="calculadora-result-eyebrow">
              você vai receber ↓
            </span>
            <div className="calculadora-result-big">
              <span>{totalLabel}</span>
              <small>líquido na sua conta · 0% de taxa pra você</small>
            </div>

            <div className="calculadora-buys">
              <span className="calculadora-buys-label">
                com isso você compra ↓
              </span>
              <div className="calculadora-buys-grid">
                <div className="calculadora-buy">
                  <span className="calculadora-buy-emoji">👶</span>
                  <div>
                    <div className="calculadora-buy-qty">{buys.diapers}</div>
                    <div className="calculadora-buy-item">
                      de fralda
                    </div>
                  </div>
                </div>
                <div className="calculadora-buy">
                  <span className="calculadora-buy-emoji">🍼</span>
                  <div>
                    <div className="calculadora-buy-qty">{buys.milk}</div>
                    <div className="calculadora-buy-item">
                      de fórmula
                    </div>
                  </div>
                </div>
                <div className="calculadora-buy">
                  <span className="calculadora-buy-emoji">🛏️</span>
                  <div>
                    <div className="calculadora-buy-qty">{buys.crib}</div>
                    <div className="calculadora-buy-item">
                      com colchão
                    </div>
                  </div>
                </div>
                <div className="calculadora-buy">
                  <span className="calculadora-buy-emoji">🚼</span>
                  <div>
                    <div className="calculadora-buy-qty">{buys.stroller}</div>
                    <div className="calculadora-buy-item">
                      top de linha
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="calculadora-cta">
              <button
                ref={ctaRef}
                type="button"
                onClick={() => auth.open('signup', ctaRef.current)}
                className="btn-lilac"
              >
                criar minha lista grátis{' '}
                <span className="btn-cta-arrow" aria-hidden="true">
                  →
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
