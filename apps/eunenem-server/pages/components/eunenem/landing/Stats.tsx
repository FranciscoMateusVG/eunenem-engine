import { LANDING_STATS } from '@/lib/mocks/landing';

// aperture-q1j2 — trust stat band (dashed dividers between cells).
export function Stats() {
  return (
    <section className="py-11 bg-cream-2 border-y-2 border-dashed border-lilac-soft">
      <div className="mx-auto max-w-[1200px] px-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {LANDING_STATS.map((s, i) => (
          <div key={i} className="stat-divider relative text-center">
            <span className="font-display text-[42px] font-semibold text-plum block leading-none">
              {s.pre}
              <em className="not-italic text-lilac-deep">{s.em}</em>
              {s.post}
            </span>
            <div className="text-sm text-ink-soft mt-2 font-semibold tracking-wide">
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
