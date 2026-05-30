/**
 * Browser-side tRPC client (aperture-kungg).
 *
 * Uses @trpc/client v11 with the httpBatchLink. Imports the AppRouter
 * **type only** from the server — zero runtime coupling, ~5–8 KB min+gz
 * added to the client bundle.
 *
 * Server-side rendering: this module is imported by client components
 * only AFTER hydration. During SSR (`typeof window === 'undefined'`)
 * the createTRPCClient call is never reached because the components
 * that import this module fetch inside `useEffect`.
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../../server/trpc/router.js';

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/api/trpc',
    }),
  ],
});
