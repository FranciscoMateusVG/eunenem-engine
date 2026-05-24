export function NotFoundPage({ pathname }: { pathname: string }) {
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
