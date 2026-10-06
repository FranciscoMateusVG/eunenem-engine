import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';
import { adminAuthOverrides } from '../../helpers/admin-auth.js';

/**
 * aperture-9bpre / aperture-zn5cm — admin.receita.* : gate e validação de
 * entrada, sem banco.
 *
 * O `db` é um proxy que explode se tocado: prova que 401/403 e período
 * inválido são decididos ANTES de qualquer leitura financeira. Fórmulas,
 * snapshot e escopo são provados em
 * tests/integration/admin-receita.postgres.test.ts.
 */

function explodingDb(): ServerDeps['db'] {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`db touched before gate/validation: ${String(prop)}`);
      },
    },
  ) as unknown as ServerDeps['db'];
}

function buildCtx(opts: { admin: boolean }): TrpcContext {
  const auth = adminAuthOverrides();
  const deps = {
    ...auth.depsOverrides,
    clock: () => new Date('2031-06-18T15:00:00.000Z'),
    logPiiHashSalt: 'unit-salt',
    db: explodingDb(),
  } as unknown as ServerDeps;
  return {
    deps,
    headers: opts.admin ? auth.headers : new Headers(),
    resHeaders: new Headers(),
  };
}

const PERIODO = { de: '2031-01-01', ate: '2031-02-01', granularidade: 'mes' } as const;

describe('admin.receita — gate (sem banco)', () => {
  it('401 sem sessão nas duas procedures (dashboard e painel)', async () => {
    const caller = appRouter.createCaller(buildCtx({ admin: false }));
    await expect(caller.admin.receita.dashboard(PERIODO)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.admin.receita.painel()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('403 para sessão válida fora da allowlist', async () => {
    const ctx = buildCtx({ admin: true });
    (ctx.deps as { adminAllowedEmails: Set<string> }).adminAllowedEmails = new Set([
      'someone-else@example.com',
    ]);
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.receita.dashboard(PERIODO)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.admin.receita.painel()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('admin.receita — validação de entrada (sem banco)', () => {
  const caller = () => appRouter.createCaller(buildCtx({ admin: true }));

  it('rejeita datas que não existem ou fora do formato', async () => {
    for (const de of ['2031-02-30', '2031-1-01', '01/01/2031', '', '2031-01-01T00:00:00Z']) {
      await expect(caller().admin.receita.dashboard({ ...PERIODO, de })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
  });

  it('rejeita granularidade desconhecida', async () => {
    await expect(
      caller().admin.receita.dashboard({ ...PERIODO, granularidade: 'dia' as never }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejeita intervalo vazio, invertido ou com intervalos demais', async () => {
    await expect(
      caller().admin.receita.dashboard({ ...PERIODO, ate: PERIODO.de }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'invalid_receita_periodo:intervalo_vazio',
    });
    await expect(
      caller().admin.receita.dashboard({ ...PERIODO, ate: '2030-12-01' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().admin.receita.dashboard({
        de: '2020-01-01',
        ate: '2031-02-01',
        granularidade: 'semana',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'invalid_receita_periodo:buckets_demais',
    });
  });
});
