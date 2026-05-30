import { useEffect, useState } from 'react';
import { trpc } from './lib/trpcClient.js';

/**
 * tRPC smoke test page (aperture-kungg) — proves the end-to-end pipeline:
 *
 *   SSR placeholder → hydration → @trpc/client httpBatchLink →
 *   POST /api/trpc/listFruits → @trpc/server fetchRequestHandler →
 *   appRouter.listFruits.query() → typed response → render
 *
 * Status surfaces (loading / error / fruits) make it obvious in a browser
 * whether the fetch succeeded. Type of `fruits` is inferred from the
 * AppRouter procedure — no manual interface needed.
 */
export function TrpcSmokePage() {
  const [fruits, setFruits] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.listFruits
      .query()
      .then((data) => {
        if (!cancelled) setFruits(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-bold text-ink mb-2">tRPC smoke test</h1>
      <p className="text-sm text-ink/60 mb-8">
        Calls <code className="font-mono text-xs bg-cream px-1.5 py-0.5 rounded">listFruits</code>{' '}
        via @trpc/client → POST /api/trpc/listFruits. Renders the response below.
      </p>

      {error && (
        <div
          data-testid="trpc-smoke-error"
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-800"
        >
          <strong className="font-semibold">tRPC error:</strong> {error}
        </div>
      )}

      {!fruits && !error && (
        <div data-testid="trpc-smoke-loading" className="text-ink/60 italic">
          Loading fruits…
        </div>
      )}

      {fruits && (
        <ul data-testid="trpc-smoke-fruits" className="space-y-2">
          {fruits.map((fruit) => (
            <li
              key={fruit}
              className="rounded-md border border-ink/10 bg-white px-4 py-2 text-ink shadow-sm"
            >
              {fruit}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
