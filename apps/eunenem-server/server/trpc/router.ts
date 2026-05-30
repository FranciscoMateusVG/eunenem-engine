/**
 * tRPC router for eunenem-server.
 *
 * Smoke procedure (`listFruits`) introduced in aperture-kungg as the first
 * end-to-end tRPC integration. Lives server-side only; the client imports
 * the `AppRouter` *type* (zero runtime cost) via @trpc/client to get
 * full type inference on procedure inputs and outputs.
 *
 * Pattern: vanilla tRPC v11 — no react-query, no Zod schemas yet. Add those
 * deps when a real procedure needs input validation.
 */
import { initTRPC } from '@trpc/server';

const t = initTRPC.create();

export const appRouter = t.router({
  /**
   * Smoke: returns a fixed list of Brazilian fruit names. Operator's
   * verification gate for the tRPC pipeline.
   */
  listFruits: t.procedure.query(() => {
    return ['maçã', 'banana', 'morango', 'abacaxi', 'manga'] as const;
  }),
});

export type AppRouter = typeof appRouter;
