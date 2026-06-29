// aperture-hsm41 — v2 §04 Diferenciais
// 5-card bento grid on a lilac-soft background. Card 1 is a plum hero with
// the headline "7,5%" stat; cards 2-5 are white with category icons. Content
// is inlined (not driven from LANDING_DIFFERENTIALS) because each card has a
// bespoke shape — a uniform mock array can't carry the hero/timeline/world/
// icon variants. Bespoke layout lives in tailwind.css under the
// /* aperture-hsm41 */ block (diff-grid, diff-hero, diff-num, timeline-*,
// world-vis, currency, globe, floaty).
export function Differential() {
  return (
    <section
      id="diferenciais"
      className="diff-section fade-up py-22 overflow-hidden bg-lilac-soft"
    >
      <div className="mx-auto max-w-[1200px] px-6 relative z-10">
        <div className="text-center max-w-[760px] mx-auto mb-14">
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            por que escolher a EuNeném
          </span>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-[44px] font-semibold text-plum leading-tight text-balance">
            o que <em className="not-italic text-lilac-deep">só a gente</em> faz
            por você
          </h2>
          <p className="text-[17px] text-ink-soft mt-3.5 text-pretty">
            Não é só uma lista de presentes. É uma plataforma sólida, feita há
            mais de uma década ouvindo mães de verdade.
          </p>
        </div>

        <div className="diff-grid">
          {/* 1. HERO — taxa */}
          <div className="diff-card diff-hero">
            <span className="diff-tag">menor taxa do mercado</span>
            <h3 className="font-display">7,8% — e você ainda recebe 100%</h3>
            <div className="diff-hero-row">
              <div className="diff-num font-display">
                7,8<small>%</small>
              </div>
            </div>
            <p>
              Concorrentes cobram 8% a 12% — convidado paga a taxa e você
              recebe 100% do valor do presente.
            </p>
          </div>

          {/* 2. Pioneira 2014 */}
          <div className="diff-card diff-since">
            <div className="diff-icon c2">
              <svg
                viewBox="0 0 32 32"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 14c0-6 5-10 10-10s10 4 10 10v6l3 4H3l3-4v-6z" />
                <path d="M13 28a3 3 0 006 0" />
              </svg>
            </div>
            <span className="diff-eyebrow">pioneira no Brasil</span>
            <h3 className="font-display">
              no ar desde{' '}
              <em className="not-italic text-coral-pink">2014</em>
            </h3>
            <p>
              Mais de uma década cuidando do enxoval de mais de 300 mil bebês.
              A gente sabe o que dá certo — e o que dá errado.
            </p>
            <div className="flex flex-col gap-2 mt-3.5">
              <div className="timeline-bar">
                <div className="timeline-fill" />
              </div>
              <div className="timeline-ticks">
                <span>2014</span>
                <span>2018</span>
                <span>2022</span>
                <span>hoje</span>
              </div>
            </div>
          </div>

          {/* 3. Multimoedas */}
          <div className="diff-card diff-world">
            <span className="diff-tag diff-tag-lilac">único no Brasil</span>
            <h3 className="font-display">família no exterior? sem problema</h3>
            <p>
              Aceita pagamento em USD, EUR, GBP, JPY e mais. Convidado paga na
              moeda dele, você recebe em real via Pix.
            </p>
            <div className="world-vis" aria-hidden="true">
              <span className="currency c1">USD $</span>
              <span className="currency c2">EUR €</span>
              <span className="currency c3">GBP £</span>
              <span className="currency c4">JPY ¥</span>
              <span className="globe">🌎</span>
            </div>
          </div>

          {/* 4. Sem taxa de resgate */}
          <div className="diff-card diff-no-fee">
            <div className="diff-icon c1">
              <svg
                viewBox="0 0 32 32"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="4" y="9" width="24" height="16" rx="2" />
                <circle cx="16" cy="17" r="3.5" />
                <path d="M8 14h2M22 14h2M8 22h2M22 22h2" />
              </svg>
            </div>
            <span className="diff-eyebrow">resgate</span>
            <h3 className="font-display">saque ilimitado, taxa zero</h3>
            <p>
              Pix em até 10 minutos. Quantos saques você quiser, sem custo. Os
              outros cobram R$ 7,90 por saque.
            </p>
          </div>

          {/* 5. Suporte humano */}
          <div className="diff-card diff-support">
            <div className="diff-icon c3">
              <svg
                viewBox="0 0 32 32"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 19c0-6 4-11 10-11s10 5 10 11v3a3 3 0 01-3 3h-2v-7h5" />
                <path d="M6 22v-7h5v7H8a2 2 0 01-2-2z" />
              </svg>
            </div>
            <span className="diff-eyebrow">atendimento</span>
            <h3 className="font-display">gente de verdade no WhatsApp</h3>
            <p>
              Convidado não conseguiu pagar? Esqueceu a senha? Manda mensagem —
              quem responde é gente, não robô.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
