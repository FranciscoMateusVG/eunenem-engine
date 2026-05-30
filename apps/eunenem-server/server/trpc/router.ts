/**
 * tRPC router for eunenem-server (aperture-kungg + aperture-ht7sq).
 *
 * Procedures:
 *   - `listFruits`    — original smoke test from aperture-kungg
 *   - `auth.signUp`   — wraps `registrarContaUsuario` (Mount-Option-A2)
 *   - `auth.signIn`   — wraps `criarSessaoUsuario`
 *   - `auth.signOut`  — revokes the session + clears cookie
 *   - `auth.me`       — returns the current Usuario or null
 *
 * Client side imports `AppRouter` as a type only — zero runtime coupling.
 */
import { initTRPC } from '@trpc/server';
import { authRouter } from './auth-router.js';
import type { TrpcContext } from './context.js';

const t = initTRPC.context<TrpcContext>().create();

export const appRouter = t.router({
  /**
   * Smoke: returns a fixed list of Brazilian fruit names. Operator's
   * verification gate for the tRPC pipeline (aperture-kungg, PR #44).
   */
  listFruits: t.procedure.query(() => {
    return ['maçã', 'banana', 'morango', 'abacaxi', 'manga'] as const;
  }),
  auth: authRouter,
});

export type AppRouter = typeof appRouter;
