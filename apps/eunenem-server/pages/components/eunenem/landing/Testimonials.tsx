import { LANDING_TESTIMONIALS } from '@/lib/mocks/landing';
import { TestiCard } from './TestiCard';

// aperture-q1j2 — full 3-up testimonial grid ("deixa as mães e pais responderem").
export function Testimonials() {
  return (
    <section id="depoimentos" className="fade-up py-22 bg-cream">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="text-center max-w-[760px] mx-auto mb-14">
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            a EuNeném é confiável?
          </span>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            deixa as{' '}
            <em className="not-italic text-lilac-deep">mães e pais</em> responderem
          </h2>
          <p className="text-[17px] text-ink-soft mt-3.5">
            Mais de 300 mil famílias já fizeram a lista com a gente.
          </p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {LANDING_TESTIMONIALS.map((t) => (
            <TestiCard key={t.name} {...t} />
          ))}
        </div>
      </div>
    </section>
  );
}
