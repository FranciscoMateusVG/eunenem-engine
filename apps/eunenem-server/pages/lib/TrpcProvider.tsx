import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { useState, type ReactNode } from 'react';
import { trpc } from './trpc.js';

/**
 * Root provider for tRPC react-query (aperture-7337j).
 *
 * Mounts both providers in one wrapper so every route in the app gets
 * `trpc.X.useQuery()` for free. Wired into pages/App.tsx so SSR and
 * client hydration render the SAME tree (no hydration mismatch).
 *
 * **Per-render QueryClient + tRPC client** (`useState(() => new ...)`):
 * fresh instance per mount, NOT shared across users on the server. Without
 * this, an SSR fetch by user A could surface in user B's response. The
 * useState initializer runs once per component lifetime — on the server
 * that's once per request, on the client that's once for the app's life.
 *
 * **SSR data-fetching is NOT wired yet.** Today, server-side renders
 * always show the loading state; the client hydrates and fetches.
 * That's fine for a dev-only smoke and matches the vanilla path on
 * /trpc-smoke. When you want real SSR-prefetched data:
 *
 *   1. On the server, build a server-side caller per request:
 *        const caller = appRouter.createCaller({});
 *      Call procedures directly (no HTTP roundtrip).
 *   2. Seed react-query's cache via `queryClient.setQueryData` or
 *      `prefetchQuery` BEFORE renderToString.
 *   3. Dehydrate with `@tanstack/react-query`'s `dehydrate(queryClient)`,
 *      serialize the dehydrated state into the HTML envelope, hydrate
 *      on the client via `HydrationBoundary`.
 *   4. Components keep using the same `trpc.X.useQuery()` call — they
 *      get the SSR-prefetched data instantly, no client-side fetch.
 *
 * Until then, every `useQuery` does a client-side fetch on mount.
 */
export function TrpcProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Sensible defaults for the eunenem-server use case. Override
            // per-query via `useQuery({ staleTime: ... })` if needed.
            staleTime: 30_000, // 30s — avoid refetch on focus for the same data
            retry: 1, // single retry on failure; tRPC errors usually mean intent, not network
          },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          // Relative URL — fine on the client (same-origin). During SSR
          // no fetch actually runs (see file comment), so the missing
          // host is never exercised. If you later add a separate API
          // host or RN client, switch to an absolute URL.
          url: '/api/trpc',
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
