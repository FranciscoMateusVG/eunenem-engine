import { LANDING_INVITES, LANDING_LINKS } from '@/lib/mocks/landing';

// aperture-q1j2 — digital-invite gallery (three tilt-on-hover preview cards).
export function Invites() {
  return (
    <section id="convites" className="fade-up py-22 bg-cream">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="text-center max-w-[760px] mx-auto mb-14">
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            convites digitais
          </span>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            crie um convite{' '}
            <em className="not-italic text-lilac-deep">lindo</em> para o seu
            evento
          </h2>
          <p className="text-[17px] text-ink-soft mt-3.5 text-pretty">
            São vários modelos incríveis para você personalizar. Encontre o que
            mais combina com seu estilo.
          </p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-10">
          {LANDING_INVITES.map((it, i) => (
            <div
              key={i}
              className="aspect-[3/4] rounded-3xl overflow-hidden relative shadow-soft-md hover:shadow-soft-lg hover:-translate-y-2 hover:-rotate-1 transition-all cursor-pointer"
              style={{ background: it.bg }}
            >
              <div className="absolute inset-5 border-[1.5px] border-white/70 rounded-2xl p-6 flex flex-col items-center justify-between text-center">
                <span className="font-script text-[22px] text-ink/85 font-semibold">
                  {it.top}
                </span>
                <div>
                  <div className="font-display text-[32px] leading-tight text-ink font-semibold text-balance">
                    {it.titleLines[0]}
                    <br />
                    {it.titleLines[1]}
                  </div>
                  <div className="w-7 h-0.5 bg-ink/40 mx-auto my-3 rounded" />
                  <div className="text-xs text-ink/75 tracking-wider uppercase font-semibold">
                    {it.name}
                  </div>
                </div>
                <span className="font-script text-[22px] text-ink/85 font-semibold">
                  {it.bot}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="text-center">
          <a href={LANDING_LINKS.convites} className="btn-outline">
            ver todos os modelos
          </a>
        </div>
      </div>
    </section>
  );
}
