/**
 * Vanilla tRPC client (aperture-kungg, kept under aperture-7337j).
 *
 * **Prefer the react-query hooks for components.** Import `trpc` from
 * `./trpc.js` and call `trpc.X.useQuery()` / `trpc.X.useMutation()`.
 * react-query handles caching, retries, loading state, invalidation,
 * race conditions on unmount — all the boilerplate you'd write by hand
 * with this client.
 *
 * This module exists for **non-React contexts** where the hook path
 * doesn't fit:
 *   - Plain async helpers outside the React tree
 *   - Tests / scripts / one-off imperative calls
 *   - Code that needs to fire a procedure exactly once at module load
 *
 * Inside a React component, use the hook path instead.
 *
 * Uses @trpc/client v11 with httpBatchLink. Imports `AppRouter` as a
 * type only — zero runtime coupling between server and client modules.
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../../server/trpc/router.js';

export const trpcVanilla = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/api/trpc',
    }),
  ],
});
