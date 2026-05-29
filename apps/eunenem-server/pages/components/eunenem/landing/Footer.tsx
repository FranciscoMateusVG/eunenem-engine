import {
  LANDING_FOOTER_COLS,
  LANDING_FOOTER_SOCIALS,
} from '@/lib/mocks/landing';

// aperture-q1j2 — plum-background marketing footer (brand blurb, link
// columns, copyright row + social chips).
export function Footer() {
  return (
    <footer className="bg-plum text-[#F4DCEA] pt-16 pb-7">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_2fr] gap-14 mb-12">
          <div>
            <img
              src="/public/logo-landing.png"
              alt="EuNeném"
              width={220}
              height={70}
              className="h-[70px] w-auto bg-white/95 px-4 py-2.5 rounded-2xl"
            />
            <p className="mt-4.5 text-sm text-[#F4DCEA]/75 max-w-[320px] leading-relaxed">
              A plataforma líder e mais confiável de chá de bebê online no Brasil
              — desde 2014, ajudando famílias a celebrarem com liberdade.
            </p>
            <div className="flex gap-2.5 mt-5 flex-wrap">
              <span className="px-3 py-1.5 border border-[#F4DCEA]/20 rounded-full text-xs text-[#F4DCEA]/85 font-semibold">
                🔒 Stripe
              </span>
              <span className="px-3 py-1.5 border border-[#F4DCEA]/20 rounded-full text-xs text-[#F4DCEA]/85 font-semibold">
                SSL · dados protegidos
              </span>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-7">
            {LANDING_FOOTER_COLS.map((col) => (
              <div key={col.title}>
                <h4 className="font-display text-sm font-semibold text-cream mb-4 lowercase tracking-wide">
                  {col.title}
                </h4>
                <ul className="list-none space-y-2.5">
                  {col.links.map(([label, href]) => (
                    <li key={label}>
                      <a
                        href={href}
                        className="text-sm text-[#F4DCEA]/80 hover:text-yellow transition-colors"
                      >
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="border-t border-[#F4DCEA]/10 pt-6 flex flex-wrap justify-between items-center gap-4">
          <div className="text-[12.5px] text-[#F4DCEA]/60">
            © 2026 EuNeném® · feito com ❤️ no Brasil
          </div>
          <div className="flex gap-2.5">
            {LANDING_FOOTER_SOCIALS.map(([href, label]) => (
              <a
                key={label}
                href={href}
                aria-label={label}
                className="w-9 h-9 rounded-full bg-[#F4DCEA]/10 inline-flex items-center justify-center hover:bg-lilac hover:-translate-y-0.5 transition-all"
              >
                <span className="text-cream text-[11px] font-bold">
                  {label[0]}
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
