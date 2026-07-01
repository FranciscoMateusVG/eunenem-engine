/**
 * tRPC router for eunenem-server (aperture-kungg + aperture-ht7sq + aperture-d6atj).
 *
 * Procedures:
 *   - `listFruits`              — original smoke test from aperture-kungg
 *   - `auth.signUp`             — wraps `registrarContaUsuario` (Mount-Option-A2)
 *   - `auth.signIn`             — wraps `criarSessaoUsuario`
 *   - `auth.signOut`            — revokes the session + clears cookie
 *   - `auth.me`                 — returns the current Usuario or null
 *   - `contribuicao.list`       — list caller's presentes (aperture-d6atj)
 *   - `contribuicao.create`     — batched create-by-qty
 *   - `contribuicao.update`     — single update with status + tenant guards
 *   - `contribuicao.delete`     — batched delete by ids
 *
 * Client side imports `AppRouter` as a type only — zero runtime coupling.
 */
import { initTRPC } from '@trpc/server';
import { adminRouter } from './admin-router.js';
import { authRouter } from './auth-router.js';
import { contribuicaoRouter } from './contribuicao-router.js';
import type { TrpcContext } from './context.js';
import { dadosRecebimentoRouter } from './dados-recebimento-router.js';
import { landingRouter } from './landing-router.js';
import { eventoConviteRouter } from './evento-convite-router.js';
import { paginaRouter } from './pagina-router.js';
import { painelMensagensRouter } from './painel-mensagens-router.js';
import { perfilRouter } from './perfil-router.js';
import { recebedorRouter } from './recebedor-router.js';
import { usuarioRouter } from './usuario-router.js';

const t = initTRPC.context<TrpcContext>().create();

export const appRouter = t.router({
  /**
   * Smoke: returns a fixed list of Brazilian fruit names. Operator's
   * verification gate for the tRPC pipeline (aperture-kungg, PR #44).
   */
  listFruits: t.procedure.query(() => {
    return ['maçã', 'banana', 'morango', 'abacaxi', 'manga'] as const;
  }),
  admin: adminRouter,
  auth: authRouter,
  contribuicao: contribuicaoRouter,
  dadosRecebimento: dadosRecebimentoRouter,
  eventoConvite: eventoConviteRouter,
  landing: landingRouter,
  pagina: paginaRouter,
  painelMensagens: painelMensagensRouter,
  perfil: perfilRouter,
  recebedor: recebedorRouter,
  usuario: usuarioRouter,
});

export type AppRouter = typeof appRouter;
