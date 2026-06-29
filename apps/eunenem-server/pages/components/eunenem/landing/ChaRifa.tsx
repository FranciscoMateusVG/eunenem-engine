// aperture-397x0 — "chá rifa" teaser section. Plum background, dotted
// noise overlay, two-column grid: copy + email capture on the left, a
// tilted paper raffle-ticket mock on the right with a coral "em breve"
// stamp. Mirrors v2 HTML section 09 ("09 Chá rifa"). The submit handler
// is a local optimistic stub — no backend wiring in this slice.
import { useState, type FormEvent } from 'react';

export function ChaRifa() {
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitted(true);
  };

  return (
    <section
      id="cha-rifa"
      data-screen-label="09 Chá rifa"
      className="cha-rifa fade-up"
    >
      <div className="mx-auto max-w-[1200px] px-6 cha-rifa-inner">
        <div className="cha-rifa-copy">
          <span className="cha-rifa-soon-badge">
            <span className="cha-rifa-pulse" aria-hidden="true" /> em breve
          </span>
          <h2 className="cha-rifa-h2">
            Chá rifa: brincadeira{' '}
            <em className="not-italic cha-rifa-em">nova</em>, chegando logo
          </h2>
          <p className="cha-rifa-lede">
            Sorteio entre os convidados dentro da plataforma. Quer ser uma das
            primeiras a saber?
          </p>
          {submitted ? (
            <div className="cha-rifa-thanks" role="status">
              ✿ feito! a gente te avisa quando o chá rifa entrar no ar.
            </div>
          ) : (
            <form className="cha-rifa-form" onSubmit={handleSubmit}>
              <input
                type="email"
                placeholder="seu melhor e-mail"
                required
                aria-label="E-mail para aviso de lançamento"
              />
              <button type="submit">me avise!</button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
