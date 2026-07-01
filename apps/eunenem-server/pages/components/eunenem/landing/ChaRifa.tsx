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
            Já dá pra fazer chá de bebê, chá de fraldas e chá revelação na
            EuNeném. O <strong>chá rifa</strong> tá chegando — sorteio entre
            os convidados, e o presentão vai pra um só. Quer ser uma das
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
          <p className="cha-rifa-meta">Zero spam. Só um e-mail quando for hora.</p>
        </div>
        <div aria-hidden="true" className="cha-rifa-ticket-wrap">
          <div className="cha-rifa-ticket">
            <div className="cha-rifa-stamp">em breve!</div>
            <div className="cha-rifa-ticket-top">
              <span className="cha-rifa-ticket-label">chá rifa</span>
              <span className="cha-rifa-ticket-num">№ 042</span>
            </div>
            <div className="cha-rifa-ticket-mid">
              <h4>
                1 sorteio,
                <br />1 presente lindo
              </h4>
              <p>Cada presente vira um número. Um convidado leva tudo.</p>
            </div>
            <div className="cha-rifa-ticket-foot">
              <span className="cha-rifa-tag">chá de bebê</span>
              <span className="cha-rifa-tag">chá de fraldas</span>
              <span className="cha-rifa-tag">chá revelação</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
