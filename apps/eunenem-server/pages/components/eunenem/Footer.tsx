// aperture-19ebe — shared rich footer.
//
// Single canonical footer used by LandingPage, PaginaPage (guest) and
// PaginaSucessoPage. Plum-background marketing footer: brand logo + blurb,
// security seals, link columns, copyright row + social chips. Replaces the
// old minimal guest-page footer (and its "preview/mockados" notice, which
// must never appear in production).
//
// aperture-zeueb — footer parity pass: real trust badges (was 2 text pills),
// real social SVG icons (were I/F/P/W letter placeholders), and a legible
// column-title color (the base `h1..h4 { color: var(--plum) }` rule was
// rendering the titles plum-on-plum — invisible on the dark footer).
import {
  LANDING_FOOTER_COLS,
  LANDING_FOOTER_SOCIALS,
} from '@/lib/mocks/landing';

// aperture-zeueb — trust badges. The old site rendered these as images on a
// LIGHT footer; on the new DARK plum footer they sit on small white chips so
// the (dark/colored) brand marks stay legible. Assets copied into public/.
const BADGES: ReadonlyArray<readonly [string, string]> = [
  ['/public/stripe_logo.svg', 'Pagamento seguro via Stripe'],
  ['/public/google-site-seguro.png', 'Google site seguro'],
  ['/public/certificado-ssl.png', 'Certificado SSL'],
  ['/public/logo-reclame-aqui.png', 'Verificada no ReclameAQUI'],
];

// aperture-zeueb — single-color brand glyphs (currentColor) so they read light
// on the dark footer. Replaces the I/F/P/W letter placeholders.
function SocialIcon({ label }: { label: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    width: 17,
    height: 17,
    'aria-hidden': true as const,
  };
  switch (label.toLowerCase()) {
    case 'instagram':
      return (
        <svg {...common}>
          <path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z" />
        </svg>
      );
    case 'facebook':
      return (
        <svg {...common}>
          <path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647z" />
        </svg>
      );
    case 'pinterest':
      return (
        <svg {...common}>
          <path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z" />
        </svg>
      );
    case 'whatsapp':
      return (
        <svg {...common}>
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" />
        </svg>
      );
    default:
      return <span className="text-[11px] font-bold">{label[0]}</span>;
  }
}

export function Footer() {
  return (
    <footer className="bg-plum text-[#F4DCEA] pt-16 pb-7">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_2fr] gap-14 mb-12">
          <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
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
            {/* aperture-zeueb — 4 real trust badges (white chips for legibility
                on the dark footer) replacing the 2 text pills. */}
            <div className="flex gap-2.5 mt-5 flex-wrap items-center justify-center lg:justify-start">
              {BADGES.map(([src, alt]) => (
                <span
                  key={src}
                  className="inline-flex items-center bg-white/95 rounded-lg px-2.5 py-1.5 h-9"
                  title={alt}
                >
                  <img
                    src={src}
                    alt={alt}
                    className="h-5 w-auto object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                </span>
              ))}
            </div>
          </div>
          <div className="hidden lg:grid lg:grid-cols-3 gap-7">
            {LANDING_FOOTER_COLS.map((col) => (
              <div key={col.title}>
                {/* aperture-zeueb — explicit light color via inline style: the
                    base `h1..h4 { color: var(--plum) }` rule (unlayered) wins
                    over the text-cream utility, so the title rendered
                    plum-on-plum (invisible). Inline style beats it. */}
                <h4
                  className="font-display text-sm font-semibold mb-4 lowercase tracking-wide"
                  style={{ color: 'var(--cream)' }}
                >
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
        <div className="border-t border-[#F4DCEA]/10 pt-6 flex flex-col items-center gap-4 lg:flex-row lg:justify-between lg:items-center">
          <div className="text-[12.5px] text-[#F4DCEA]/60">
            © 2026 EuNeném® · feito com ❤️ no Brasil
          </div>
          <div className="flex gap-2.5">
            {LANDING_FOOTER_SOCIALS.map(([href, label]) => (
              <a
                key={label}
                href={href}
                aria-label={label}
                target="_blank"
                rel="noopener noreferrer"
                className="w-9 h-9 rounded-full bg-[#F4DCEA]/10 inline-flex items-center justify-center text-cream hover:bg-lilac hover:text-white hover:-translate-y-0.5 transition-all"
              >
                <SocialIcon label={label} />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
