'use client';

// Persiste e-mail via tRPC na waitlist do chá rifa.
// UX de "obrigado" após salvar; envio da notificação por e-mail será implementado em uma fase futura.
import { TRPCClientError } from '@trpc/client';
import { useState, type FormEvent } from 'react';

import { trpc } from '@/lib/trpc.js';

export function ChaRifa() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cadastrar = trpc.landing.cadastrarInteresseChaRifa.useMutation({
    onSuccess: () => {
      setSubmitted(true);
      setError(null);
    },
    onError: (err) => {
      if (err instanceof TRPCClientError && err.data?.code === 'TOO_MANY_REQUESTS') {
        setError('Muitas tentativas. Aguarde alguns instantes e tente de novo.');
        return;
      }
      setError('Não foi possível salvar agora. Tente novamente em instantes.');
    },
  });

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    cadastrar.mutate({ email: email.trim().toLowerCase() });
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
            <form onSubmit={handleSubmit}>
              <div className="cha-rifa-form">
                <input
                  type="email"
                  name="email"
                  placeholder="seu melhor e-mail"
                  required
                  aria-label="E-mail para aviso de lançamento"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={cadastrar.isPending}
                />
                <button type="submit" disabled={cadastrar.isPending}>
                  {cadastrar.isPending ? 'enviando…' : 'me avise!'}
                </button>
              </div>
              {error ? (
                <p className="cha-rifa-error" role="alert">
                  {error}
                </p>
              ) : null}
              <p className="cha-rifa-meta">
                Usaremos seu e-mail apenas para avisar sobre o lançamento do chá
                rifa.
              </p>
            </form>
          )}
        </div>

        <div className="cha-rifa-ticket-wrap" aria-hidden>
          <div className="cha-rifa-ticket">
            <span className="cha-rifa-stamp">em breve!</span>
            <div className="cha-rifa-ticket-top">
              <span className="cha-rifa-ticket-label">chá rifa</span>
            </div>
            <div className="cha-rifa-ticket-mid">
              <h4>1 sorteio, 1 presente lindo</h4>
              <p>
                Cada presente vira um número. Um convidado leva tudo.
              </p>
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
