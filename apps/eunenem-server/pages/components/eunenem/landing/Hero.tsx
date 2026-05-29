import { LANDING_LINKS } from '@/lib/mocks/landing';

// aperture-q1j2 — landing hero. Background photo + warm left-to-right
// fade overlay, scrapbook doodles, blob illustration, floating "presente
// recebido" cards. Ported verbatim from the Next.js prototype.
export function Hero() {
  return (
    <header className="relative pt-14 pb-22 overflow-hidden isolate">
      {/* Background photo + warm overlay */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-cover bg-no-repeat"
        style={{
          backgroundImage: "url('/public/hero-bg.jpg')",
          backgroundPosition: 'center 15%',
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(90deg, rgba(248,247,246,0.98) 0%, rgba(248,247,246,0.96) 30%, rgba(248,247,246,0.82) 42%, rgba(248,247,246,0.35) 50%, rgba(248,247,246,0) 58%)',
          }}
        />
      </div>
      {/* Doodles */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none z-0 overflow-hidden"
      >
        <svg
          className="absolute top-[8%] left-[4%] w-[38px]"
          viewBox="0 0 40 40"
          fill="none"
          stroke="#C9A5D8"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 4 L24 16 L36 17 L27 25 L30 36 L20 30 L10 36 L13 25 L4 17 L16 16 Z" />
        </svg>
        <svg
          className="absolute top-[22%] right-[6%] w-[30px]"
          viewBox="0 0 40 40"
          fill="none"
          stroke="#F4B6CD"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 32 C 8 24, 4 14, 12 10 C 16 8, 19 11, 20 14 C 21 11, 24 8, 28 10 C 36 14, 32 24, 20 32 Z" />
        </svg>
        <svg
          className="absolute bottom-[12%] left-[8%] w-[34px]"
          viewBox="0 0 40 40"
          fill="none"
          stroke="#F7D560"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 4 L24 16 L36 17 L27 25 L30 36 L20 30 L10 36 L13 25 L4 17 L16 16 Z" />
        </svg>
        <svg
          className="absolute bottom-[30%] right-[12%] w-[28px]"
          viewBox="0 0 40 40"
          fill="none"
          stroke="#9CD7DD"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 32 C 8 24, 4 14, 12 10 C 16 8, 19 11, 20 14 C 21 11, 24 8, 28 10 C 36 14, 32 24, 20 32 Z" />
        </svg>
      </div>

      <div className="relative z-10 mx-auto max-w-[1200px] px-6 grid lg:grid-cols-[1fr_1.05fr] gap-12 items-center">
        <div className="text-center lg:text-left">
          <span className="inline-block font-script text-3xl text-lilac-deep font-semibold -rotate-3 mb-2">
            aqui o carinho vira presente ✨
          </span>
          <h1 className="font-display text-4xl sm:text-5xl lg:text-[56px] leading-[1.1] font-semibold text-ink mb-6 text-balance">
            Receba o <span className="text-plum">carinho</span> de todos no seu
            chá de bebê — e o{' '}
            <span className="yellow-hl">dinheiro cai na sua conta</span>
          </h1>
          <p className="text-[17px] text-ink-soft max-w-[540px] mx-auto lg:mx-0">
            Crie sua lista em 2 minutos. Seus convidados presenteiam online,
            você recebe em dinheiro e compra o que o bebê{' '}
            <strong className="text-plum font-bold">realmente</strong> precisa.
          </p>
          <div className="flex flex-wrap items-center gap-4 mt-7 justify-center lg:justify-start">
            <a
              href={LANDING_LINKS.criarLista}
              className="btn-lilac btn-lilac-lg"
            >
              → criar minha lista grátis
            </a>
          </div>
          <p className="text-[13px] text-ink-mute mt-3.5">
            Grátis para criar · Sem cartão de crédito · Pronto em 2 minutos
          </p>
          <div className="flex flex-wrap items-center gap-3 mt-5 justify-center lg:justify-start">
            <span className="seal">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                className="w-3.5 h-3.5"
              >
                <rect x="4" y="10" width="16" height="11" rx="2" />
                <path d="M8 10V7a4 4 0 1 1 8 0v3" />
              </svg>
              Pagamentos via Stripe
            </span>
            <span className="seal">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                className="w-3.5 h-3.5"
              >
                <path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z" />
              </svg>
              SSL · dados protegidos
            </span>
            <span className="seal">+300 mil famílias</span>
          </div>
        </div>

        <div className="relative aspect-square max-w-[460px] mx-auto w-full">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                'radial-gradient(circle at 50% 50%, transparent 56%, #E8D5F0 56%, #E8D5F0 60%, transparent 60%)',
              transform: 'rotate(-12deg)',
            }}
          />
          <div
            className="absolute inset-[8%] overflow-hidden flex items-center justify-center shadow-soft-md"
            style={{
              borderRadius: '50% 50% 50% 50% / 60% 60% 40% 40%',
              background: 'linear-gradient(160deg, #FBE0EA, #E8D5F0 60%, #FBF1E0)',
            }}
          >
            <svg viewBox="0 0 200 200" fill="none" className="w-3/5 h-auto">
              <defs>
                <linearGradient id="b1" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#9CD7DD" />
                  <stop offset="100%" stopColor="#C9A5D8" />
                </linearGradient>
                <linearGradient id="b2" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#F4B6CD" />
                  <stop offset="100%" stopColor="#E78FA7" />
                </linearGradient>
              </defs>
              <g transform="translate(20 70) rotate(-8)">
                <path
                  d="M10 50 C 10 30, 30 20, 55 22 C 80 24, 90 32, 90 42 L 90 60 C 90 70, 80 76, 70 76 L 22 76 C 14 76, 10 70, 10 60 Z"
                  fill="url(#b1)"
                  stroke="#7A5A6C"
                  strokeWidth="1.5"
                />
                <ellipse cx="55" cy="22" rx="38" ry="6" fill="#fff" opacity="0.7" />
              </g>
              <g transform="translate(95 95) rotate(12)">
                <path
                  d="M10 50 C 10 30, 30 20, 55 22 C 80 24, 90 32, 90 42 L 90 60 C 90 70, 80 76, 70 76 L 22 76 C 14 76, 10 70, 10 60 Z"
                  fill="url(#b2)"
                  stroke="#7A5A6C"
                  strokeWidth="1.5"
                />
                <ellipse cx="55" cy="22" rx="38" ry="6" fill="#fff" opacity="0.7" />
              </g>
              <path
                d="M100 30 C 95 22, 80 22, 80 35 C 80 45, 100 58, 100 58 C 100 58, 120 45, 120 35 C 120 22, 105 22, 100 30 Z"
                fill="#F7D560"
                stroke="#7A5A6C"
                strokeWidth="1.2"
              />
            </svg>
          </div>

          <FloatingCard
            className="top-[6%] -left-[8%]"
            delay="0s"
            avBg="#E78FA7"
            letter="M"
            line1="Mariana presenteou"
            line2="R$ 150,00 · há 2 min"
          />
          <FloatingCard
            className="bottom-[8%] -right-[6%]"
            delay="1.6s"
            avBg="#A77BBE"
            letter="L"
            line1="Lucas presenteou ❤️"
            line2="R$ 80,00 · há 5 min"
          />
          <div
            className="absolute bottom-[36%] -left-[10%] z-20 bg-white rounded-2xl px-4 py-3 shadow-soft-md animate-float"
            style={{ animationDelay: '3s' }}
          >
            <div className="font-display text-[22px] font-semibold text-plum leading-none">
              R$ 4.280
            </div>
            <div className="text-[11px] text-ink-mute mt-0.5">
              arrecadados · 18 presentes
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function FloatingCard({
  className,
  delay,
  avBg,
  letter,
  line1,
  line2,
}: {
  className: string;
  delay: string;
  avBg: string;
  letter: string;
  line1: string;
  line2: string;
}) {
  return (
    <div
      className={`absolute z-20 bg-white rounded-2xl px-4 py-3 shadow-soft-md flex items-center gap-2.5 animate-float ${className}`}
      style={{ animationDelay: delay }}
    >
      <span
        className="w-7 h-7 rounded-full inline-flex items-center justify-center text-white font-bold text-xs font-display"
        style={{ background: avBg }}
      >
        {letter}
      </span>
      <div>
        <div className="text-xs font-bold text-plum">{line1}</div>
        <div className="text-[11px] text-ink-mute">{line2}</div>
      </div>
    </div>
  );
}
