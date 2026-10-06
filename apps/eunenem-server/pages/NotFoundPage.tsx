import { useEffect } from 'react';
import { sendPageView } from '@/lib/analytics';
import { pageViewProps } from '@/lib/rota-canonica';

export function NotFoundPage({ pathname }: { pathname: string }) {
  // aperture-ai8vg — count 404s under the fixed rota '404'; the requested
  // pathname is displayed to the visitor but NEVER sent (it may carry ids).
  useEffect(() => {
    sendPageView('Nao Encontrada', pageViewProps('/__nao_encontrada__'));
  }, []);
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <h1 className="text-4xl mb-4">página não encontrada</h1>
      <p className="text-ink-soft mb-6">
        Nada servido em <code>{pathname}</code>.
      </p>
      <a href="/" className="btn-lilac">
        voltar ao início
      </a>
    </main>
  );
}
