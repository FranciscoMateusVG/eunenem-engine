import { trpc } from './lib/trpc.js';

/**
 * tRPC smoke test page (aperture-kungg, refactored under aperture-7337j).
 *
 * Now uses the @trpc/react-query hook path — the baseline for every future
 * tRPC procedure in eunenem-server. Compare this body to the original
 * vanilla @trpc/client version (PR #44, git history): all the
 * useState / useEffect / loading / error / cleanup boilerplate is gone.
 * react-query handles it.
 *
 * Pipeline still proves the same e2e wire:
 *   SSR placeholder → hydration → trpc.listFruits.useQuery() →
 *   react-query schedules fetch → @trpc/client httpBatchLink →
 *   GET /api/trpc/listFruits?batch=1 → @trpc/server fetchRequestHandler →
 *   appRouter.listFruits.query() → typed response → react-query cache →
 *   re-render with data
 *
 * `fruits` is typed `readonly ["maçã", "banana", ...] | undefined` from
 * the AppRouter procedure return type. Zero manual interfaces.
 */
export function TrpcSmokePage() {
  const { data: fruits, error, isLoading } = trpc.listFruits.useQuery();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-bold text-ink mb-2">tRPC smoke test</h1>
      <p className="text-sm text-ink/60 mb-8">
        Calls <code className="font-mono text-xs bg-cream px-1.5 py-0.5 rounded">listFruits</code>{' '}
        via{' '}
        <code className="font-mono text-xs bg-cream px-1.5 py-0.5 rounded">
          trpc.listFruits.useQuery()
        </code>{' '}
        — @trpc/react-query hook with automatic caching, refetch, and retry.
      </p>

      {error && (
        <div
          data-testid="trpc-smoke-error"
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-800"
        >
          <strong className="font-semibold">tRPC error:</strong> {error.message}
        </div>
      )}

      {isLoading && (
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
