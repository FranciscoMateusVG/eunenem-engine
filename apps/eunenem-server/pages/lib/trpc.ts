/**
 * tRPC react-query hooks (aperture-7337j).
 *
 * `createTRPCReact<AppRouter>()` returns a proxy that mirrors the router
 * shape but exposes react-query hooks instead of Promise-returning methods.
 *
 *   - `trpc.listFruits.useQuery()`           → react-query `useQuery` hook
 *   - `trpc.someMutation.useMutation()`      → react-query `useMutation` hook
 *   - `trpc.useUtils()` (a.k.a. `useContext`) → imperative query client (invalidate, prefetch, ...)
 *
 * The procedure types flow from `AppRouter` (type-only import — esbuild
 * drops it at build time, zero runtime coupling).
 *
 * USAGE in a component:
 *   import { trpc } from './lib/trpc.js';
 *   const { data, isLoading, error } = trpc.listFruits.useQuery();
 *
 * For NON-React contexts (e.g. plain async functions outside the React
 * tree) use the vanilla client in `./trpcClient.ts`.
 */
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '../../server/trpc/router.js';

export const trpc = createTRPCReact<AppRouter>();
