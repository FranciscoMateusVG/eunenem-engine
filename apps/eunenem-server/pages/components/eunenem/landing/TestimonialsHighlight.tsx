import { LANDING_TESTIMONIALS_HIGHLIGHT } from '@/lib/mocks/landing';
import { TestiCard } from './TestiCard';

// aperture-q1j2 — two featured testimonials directly under the hero band.
export function TestimonialsHighlight() {
  return (
    <section className="fade-up py-14 bg-cream">
      <div className="mx-auto max-w-[1200px] px-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {LANDING_TESTIMONIALS_HIGHLIGHT.map((t) => (
          <TestiCard key={t.name} {...t} />
        ))}
      </div>
    </section>
  );
}
