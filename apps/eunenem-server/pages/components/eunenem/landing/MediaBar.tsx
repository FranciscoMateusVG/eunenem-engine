import { LANDING_MEDIA } from '@/lib/mocks/landing';

// aperture-q1j2 — "como visto em" press wordmark row.
export function MediaBar() {
  return (
    <section className="fade-up py-14 bg-cream-2 border-y-2 border-dashed border-lilac-soft">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="text-center font-script text-[26px] text-lilac-deep font-semibold mb-6">
          como visto em
        </div>
        <div className="flex items-center justify-between flex-wrap gap-x-11 gap-y-7">
          {LANDING_MEDIA.map((l) => (
            <span
              key={l}
              className="font-bold text-base text-ink-mute uppercase tracking-wider opacity-75 hover:opacity-100 hover:text-plum transition-all"
            >
              {l}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
