import { useEffect } from 'react';
import { sendPageView } from './lib/analytics.js';
import { TERMOS_DE_USO_BODY } from './lib/termos-de-uso.js';

// Static legal page — /termos-de-uso.
export function TermosDeUsoPage() {
  // aperture-ppuay — page-view tracking (EVENT_MAP addition).
  useEffect(() => {
    sendPageView('Termos de Uso');
  }, []);

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-line/60 bg-white/80 py-5">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <a href="/" className="inline-block">
            <img
              src="/public/logo-landing.png"
              alt="EuNeném"
              width={160}
              height={48}
              className="mx-auto h-12 w-auto"
            />
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12 pb-20">
        <h1 className="font-display text-3xl sm:text-4xl font-semibold text-plum text-center mb-3">
          Termos de uso
        </h1>
        <p className="text-center text-sm font-semibold text-plum/90 mb-10">
          CONTRATO – TERMOS E CONDIÇÕES DE USO DA PLATAFORMA EUNENÉM
        </p>
        <article className="text-ink text-sm leading-relaxed whitespace-pre-line text-pretty">
          {TERMOS_DE_USO_BODY}
        </article>
        <p className="mt-10 text-center">
          <a href="/" className="text-lilac-deep font-semibold hover:underline">
            voltar ao início
          </a>
        </p>
      </main>
    </div>
  );
}
