import type { ReactNode } from 'react';

// aperture-cvhlm — "Taxas" / transparent fees section (v2 HTML section 06).
// Cream card with the 100% headline on the left + a 3-column payout-method
// grid on the right (Pix / Cartão / Transferência). Backs the "100% em
// dinheiro" positioning by showing that the 7.5% fee is paid by guests and
// the creator's payout is never reduced.
type FeeItem = {
  label: string;
  value: string;
  detail: string;
  iconBg: string; // .taxas-icon-wrap--{f1|f2|f3} background swatch
  icon: ReactNode;
};

const FEE_ITEMS: FeeItem[] = [
  {
    label: 'Pix',
    value: '10 min',
    detail: 'após o convidado pagar',
    iconBg: 'f1',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="#A77BBE"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 12l3-9h12l3 9-9 9z" />
      </svg>
    ),
  },
  {
    label: 'Cartão',
    value: '31 dias',
    detail: 'proteção contra estorno',
    iconBg: 'f2',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="#E78FA7"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="6" width="20" height="14" rx="2" />
        <path d="M2 11h20" />
      </svg>
    ),
  },
  {
    label: 'Transferência',
    value: '3 dias úteis',
    detail: 'para a sua conta',
    iconBg: 'f3',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="#C8A340"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    ),
  },
];

export function Taxas() {
  return (
    <section
      id="taxas"
      className="taxas-section fade-up py-22 overflow-hidden"
    >
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="text-center max-w-[760px] mx-auto mb-14">
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            transparência total
          </span>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            você recebe{' '}
            <em className="not-italic text-lilac-deep">100%</em>.
            <br/>
            sem surpresa.
          </h2>
        </div>

        <div className="taxas-band">
          <div>
            <div className="taxas-headline">
              <span className="taxas-pct">100%</span>
              pra você
            </div>
            <p>
              Cada R$ 100 adiciona na sua lista cai inteirinho na sua conta. Sem
              letra miúda.
            </p>
          </div>
          <div className="taxas-grid">
            {FEE_ITEMS.map((it) => (
              <div key={it.label} className="taxas-item">
                <div className={`taxas-icon-wrap taxas-icon-wrap--${it.iconBg}`}>
                  {it.icon}
                </div>
                <div className="taxas-item-body">
                  <div className="taxas-label">{it.label}</div>
                  <div className="taxas-detail">{it.detail}</div>
                </div>
                <div className="taxas-value">{it.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
