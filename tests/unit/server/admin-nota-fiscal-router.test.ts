import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import { parseNfseConfig } from '../../../apps/eunenem-server/server/nfse/config.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';
import { adminAuthOverrides } from '../../helpers/admin-auth.js';

/**
 * aperture-dh1k7 — admin.notaFiscal.previaMensal: gate e validação de
 * entrada, sem banco. O `db` explode se tocado: 401/403, mês malformado e
 * mês futuro são decididos ANTES de qualquer leitura financeira. Valor,
 * XSD e assinatura reais ficam nos testes de fronteira (nfse-tester).
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
    nfse: parseNfseConfig({}),
  } as unknown as ServerDeps;
  return {
    deps,
    headers: opts.admin ? auth.headers : new Headers(),
    resHeaders: new Headers(),
  };
}

describe('admin.notaFiscal.previaMensal — gate (sem banco)', () => {
  it('401 sem sessão', async () => {
    const caller = appRouter.createCaller(buildCtx({ admin: false }));
    await expect(caller.admin.notaFiscal.previaMensal({ mes: '2031-05' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('403 para sessão válida fora da allowlist', async () => {
    const ctx = buildCtx({ admin: true });
    (ctx.deps as { adminAllowedEmails: Set<string> }).adminAllowedEmails = new Set([
      'someone-else@example.com',
    ]);
    const caller = appRouter.createCaller(ctx);
    await expect(caller.admin.notaFiscal.previaMensal({ mes: '2031-05' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('admin.notaFiscal.previaMensal — validação de entrada (sem banco)', () => {
  const caller = () => appRouter.createCaller(buildCtx({ admin: true }));

  it.each([
    '2031-13',
    '2031-00',
    '2031-5',
    '31-05',
    '2031-05-01',
    '',
    '05/2031',
  ])('rejeita mês %j', async (mes) => {
    await expect(caller().admin.notaFiscal.previaMensal({ mes })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejeita mês futuro (em São Paulo) antes de ler o ledger', async () => {
    await expect(caller().admin.notaFiscal.previaMensal({ mes: '2031-07' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'nfse_mes_futuro',
    });
  });

  it('mês corrente passa da validação e só então toca o banco', async () => {
    await expect(caller().admin.notaFiscal.previaMensal({ mes: '2031-06' })).rejects.toThrow(
      'db touched before gate/validation',
    );
  });
});
