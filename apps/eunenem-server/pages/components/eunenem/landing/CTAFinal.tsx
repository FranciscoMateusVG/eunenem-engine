import { useRef, useState } from 'react';
import { LANDING_CTA_FINAL_PERKS, LANDING_FAQS } from '@/lib/mocks/landing';
import { useAuthModal } from '@/components/eunenem/auth/AuthModalProvider';

// aperture-q1j2 — final CTA on a tri-stop gradient with an accordion FAQ.
// Accordion is interactive (useState), so it hydrates on the client.
// aperture-nop8l — CTA opens signup modal.
export function CTAFinal() {
  const [open, setOpen] = useState<number | null>(null);
  const auth = useAuthModal();
  const ctaRef = useRef<HTMLButtonElement | null>(null);

  return (
    <section
      id="faq"
      className="fade-up py-22 relative overflow-hidden"
      style={{
        background:
          'linear-gradient(135deg, #FBE0EA 0%, #E8D5F0 50%, #FBF1E0 100%)',
      }}
    >
      <div
        className="absolute -top-50 -left-25 w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, rgba(255,255,255,0.5), transparent 60%)',
        }}
      />
      <div
        className="absolute -bottom-50 -right-25 w-[600px] h-[600px] rounded-full pointer-events-none"
        style={{
          background:
            'radial-gradient(circle, rgba(247,213,96,0.3), transparent 60%)',
        }}
      />

      <div className="relative z-10 mx-auto max-w-[800px] px-6 text-center">
        <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
          a sua data está chegando ✨
        </span>
        <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
          quanto antes{' '}
          <em className="not-italic text-lilac-deep">criar sua lista</em>, mais
          tempo seus convidados têm.
        </h2>
        <p className="text-[17px] text-ink-soft my-6 max-w-[540px] mx-auto text-pretty">
          Junte-se a +300 mil famílias.
        </p>
        <button
          ref={ctaRef}
          type="button"
          onClick={() => auth.open('signup', ctaRef.current)}
          className="btn-lilac btn-lilac-lg"
        >
          criar minha lista grátis{' '}
          <span className="btn-cta-arrow" aria-hidden="true">
            →
          </span>
        </button>
        <ul className="cta-final-perks">
          {LANDING_CTA_FINAL_PERKS.map((label) => (
            <li key={label} className="cta-final-perk">
              <span className="cta-final-perk-check" aria-hidden="true">
                ✓
              </span>
              {label}
            </li>
          ))}
        </ul>

        <div className="mt-14 max-w-[640px] mx-auto text-left">
          {LANDING_FAQS.map((f, i) => (
            <div
              key={i}
              className={`faq-item bg-white/85 backdrop-blur border border-white/90 rounded-2xl overflow-hidden shadow-soft-sm mb-3 ${
                open === i ? 'open' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
                className="w-full text-left px-5 py-5 flex items-center justify-between gap-4 text-[15px] font-bold text-plum hover:bg-white/60 transition-colors"
              >
                <span>{f.q}</span>
                <span className="chev w-7 h-7 rounded-full bg-lilac text-white flex items-center justify-center flex-shrink-0 text-base font-bold">
                  +
                </span>
              </button>
              <div className="faq-a">
                <div className="px-5 pb-5 text-ink-soft text-[14.5px] leading-relaxed whitespace-pre-line">
                  {f.a}
                  {f.link ? (
                    <>
                      {' '}
                      <a
                        href={f.link.href}
                        className="text-lilac-deep font-bold"
                      >
                        {f.link.label}
                      </a>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
