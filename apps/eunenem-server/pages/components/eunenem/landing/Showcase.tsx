import { LANDING_LINKS } from '@/lib/mocks/landing';

// aperture-q1j2 — product showcase: notebook mock with an overlapping
// mobile mock, paired with the "perfeita para todos os momentos" copy.
export function Showcase() {
  return (
    <section className="fade-up py-18 bg-cream">
      <div className="mx-auto max-w-[1200px] px-6 grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-12 items-center">
        <div className="relative">
          <img
            src="/public/notebook-mock.png"
            alt="Plataforma EuNeném no notebook"
            width={720}
            height={480}
            className="w-full h-auto"
          />
          <img
            src="/public/mobile-mock.png"
            alt="Plataforma EuNeném no celular"
            width={280}
            height={560}
            className="absolute w-[38%] -bottom-[8%] -right-[4%] z-10 h-auto"
          />
        </div>
        <div>
          <span className="font-script text-[28px] text-lilac-deep font-semibold inline-block -rotate-2 mb-1">
            prático para todo mundo
          </span>
          <h2 className="font-display text-3xl lg:text-4xl font-semibold text-plum mb-4 leading-tight">
            perfeita para{' '}
            <em className="not-italic text-lilac-deep">todos os momentos</em>
          </h2>
          <p className="text-ink-soft text-base mb-3.5 max-w-[520px]">
            Com alguns cliques você faz a sua lista de presentes online, cria o
            seu convite personalizado e compartilha com todos os familiares e
            amigos, até mesmo com os que estão distantes.{' '}
            <strong className="text-plum font-bold">
              Não deixe ninguém de fora deste momento.
            </strong>
          </p>
          <p className="text-ink-soft text-base mb-6 max-w-[520px]">
            De um jeito simples e prático, seus convidados podem te presentear de
            onde estiverem, evitando filas e presentes repetidos, sabendo que o
            dinheiro será utilizado da melhor forma para o bebê.
          </p>
          <a href={LANDING_LINKS.criarLista} className="btn-lilac">
            criar minha lista grátis
          </a>
        </div>
      </div>
    </section>
  );
}
