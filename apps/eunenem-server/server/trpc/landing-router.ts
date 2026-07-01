import { randomUUID } from 'node:crypto';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { hashClientPII } from '../../../../src/index.js';
import { ID_PLATAFORMA_EUNENEM } from '../auth/setup.js';
import { trustedClientIp } from '../lib/security/trusted-client-ip.js';
import type { TrpcContext } from './context.js';
import { enforceRateLimit } from './rate-limit.js';

const t = initTRPC.context<TrpcContext>().create();

/**
 * Apenas captura. Envio de notificação por e-mail será implementado em uma fase futura.
 *
 * Router público da landing: procedures sem auth para formulários de
 * visitante (ex.: waitlist do chá rifa). Não dispara e-mail nem export.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_CHA_RIFA_MAX = 5;

export const CadastrarInteresseChaRifaInputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
});

export const landingRouter = t.router({
  /**
   * INSERT idempotente na lista de espera do chá rifa. Não dispara notificação.
   * Retorno sempre `{ ok: true }` — não vaza erro se o e-mail já existia na lista de espera.
   */
  cadastrarInteresseChaRifa: t.procedure
    .input(CadastrarInteresseChaRifaInputSchema)
    .mutation(async ({ ctx, input }) => {
      const { deps } = ctx;

      const rawIp = trustedClientIp(ctx.headers, deps.trustedHopCount);
      const ipHashed = hashClientPII(rawIp, deps.logPiiHashSalt);
      const emailHash = hashClientPII(input.email, deps.logPiiHashSalt);

      await enforceRateLimit(deps.db, {
        key: `trpc:chaRifaWaitlist:${ipHashed}`,
        max: RATE_LIMIT_CHA_RIFA_MAX,
        windowMs: RATE_LIMIT_WINDOW_MS,
        clock: deps.clock,
      });

      await deps.db
        .insertInto('cha_rifa_waitlist')
        .values({
          id: randomUUID(),
          id_plataforma: ID_PLATAFORMA_EUNENEM,
          email: input.email,
        })
        .onConflict((oc) =>
          oc.columns(['id_plataforma', 'email']).doNothing(),
        )
        .execute();

      deps.observability.logger.info('landing.cha_rifa_waitlist.cadastro', {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        emailHash,
        ipHashed,
        timestampIso: new Date().toISOString(),
      });

      return { ok: true as const };
    }),
});
