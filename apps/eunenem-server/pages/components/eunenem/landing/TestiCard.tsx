import type { LandingTestimonial } from '@/lib/mocks/landing';

// aperture-q1j2 — single testimonial card (5 stars, quote, avatar + name).
// Shared by TestimonialsHighlight (2-up) and Testimonials (3-up).
export function TestiCard({ quote, img, name, meta }: LandingTestimonial) {
  return (
    <article className="testi-card bg-white rounded-3xl p-7 shadow-soft-sm hover:shadow-soft-md hover:-translate-y-1 transition-all border border-line">
      <div className="text-yellow tracking-[2px] text-base mb-3 shrink-0">★★★★★</div>
      <p className="testi-card-quote text-base leading-relaxed text-ink text-pretty">
        {quote}
      </p>
      <div className="mt-5 flex items-center gap-3 shrink-0">
        <img
          src={img}
          alt={name}
          width={48}
          height={48}
          className="w-12 h-12 rounded-full object-cover border-2 border-cream-2 flex-shrink-0"
        />
        <div>
          <div className="font-display text-[15px] font-bold text-plum">
            {name}
          </div>
          <div className="text-xs text-ink-mute">{meta}</div>
        </div>
      </div>
    </article>
  );
}
