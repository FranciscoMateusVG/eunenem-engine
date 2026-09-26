import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import { maskCelularTitular } from '../../../apps/eunenem-server/server/trpc/admin-router.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';
import { adminAuthOverrides } from '../../helpers/admin-auth.js';

/**
 * aperture-5jk8y — admin.usuarios.financeiro.* : gate + escopo, sem banco.
 *
 * O que este arquivo prova (memória, sem Postgres):
 *   - 401 sem sessão e 403 fora da allowlist nas TRÊS procedures, ANTES de
 *     qualquer leitura financeira (o `db` é um proxy que explode se tocado).
 *   - idConta desconhecido / de outra plataforma ⇒ `null` nas três, também
 *     sem tocar o `db` (findUsuarioByConta governa o escopo).
 *   - máscara do celular.
 *
 * Dedup, coadmins, totais, cursor, snapshot e SQL são provados em
 * tests/integration/admin-usuario-financeiro.postgres.test.ts.
 */

const NOW = new Date('2026-09-26T12:00:00.000Z');

function explodingDb(): ServerDeps['db'] {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`db touched before scope resolution: ${String(prop)}`);
      },
    },
  ) as unknown as ServerDeps['db'];
}

function buildCtx(opts: { admin: boolean; usuarioByConta?: unknown }): TrpcContext {
  const auth = adminAuthOverrides();
  const stubbedUsuarioRepo = auth.depsOverrides.usuarioRepository as unknown as {
    findUsuarioById: (id: string) => Promise<unknown>;
  };
  const deps = {
    ...auth.depsOverrides,
    usuarioRepository: {
      findUsuarioById: stubbedUsuarioRepo.findUsuarioById,
      findUsuarioByConta: async () => opts.usuarioByConta,
    },
    clock: () => NOW,
    logPiiHashSalt: 'unit-salt',
    db: explodingDb(),
  } as unknown as ServerDeps;
  return {
    deps,
    headers: opts.admin ? auth.headers : new Headers(),
    resHeaders: new Headers(),
  };
}

const ID_CONTA = randomUUID();

describe('admin.usuarios.financeiro — gate e escopo (sem banco)', () => {
  it('401 sem sessão nas três procedures', async () => {
    const caller = appRouter.createCaller(buildCtx({ admin: false }));
    await expect(
      caller.admin.usuarios.financeiro.summary({ idConta: ID_CONTA }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller.admin.usuarios.financeiro.lancamentos.listPaginated({
        idConta: ID_CONTA,
        cursor: null,
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      caller.admin.usuarios.financeiro.repasses.listPaginated({
        idConta: ID_CONTA,
        cursor: null,
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('403 para sessão válida fora da allowlist', async () => {
    const ctx = buildCtx({ admin: true });
    (ctx.deps as { adminAllowedEmails: Set<string> }).adminAllowedEmails = new Set([
      'someone-else@example.com',
    ]);
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.admin.usuarios.financeiro.summary({ idConta: ID_CONTA }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('idConta desconhecido ou de outra plataforma ⇒ null nas três, sem tocar o banco', async () => {
    const caller = appRouter.createCaller(buildCtx({ admin: true, usuarioByConta: undefined }));
    expect(await caller.admin.usuarios.financeiro.summary({ idConta: ID_CONTA })).toBeNull();
    expect(
      await caller.admin.usuarios.financeiro.lancamentos.listPaginated({
        idConta: ID_CONTA,
        cursor: null,
        limit: 10,
      }),
    ).toBeNull();
    expect(
      await caller.admin.usuarios.financeiro.repasses.listPaginated({
        idConta: ID_CONTA,
        cursor: null,
        limit: 10,
      }),
    ).toBeNull();
  });

  it('valida input: limit fora de 1..100 e estado desconhecido são rejeitados', async () => {
    const caller = appRouter.createCaller(buildCtx({ admin: true, usuarioByConta: undefined }));
    await expect(
      caller.admin.usuarios.financeiro.lancamentos.listPaginated({
        idConta: ID_CONTA,
        cursor: null,
        limit: 101,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.usuarios.financeiro.lancamentos.listPaginated({
        idConta: ID_CONTA,
        cursor: null,
        limit: 10,
        estado: 'inventado' as never,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('maskCelularTitular', () => {
  it('mostra só os 4 últimos dígitos', () => {
    expect(maskCelularTitular('11987654321')).toBe('(**) *****-4321');
    expect(maskCelularTitular('+55 (11) 98765-4321')).toBe('(**) *****-4321');
  });
  it('null / vazio / sem dígitos ⇒ null', () => {
    expect(maskCelularTitular(null)).toBeNull();
    expect(maskCelularTitular(undefined)).toBeNull();
    expect(maskCelularTitular('')).toBeNull();
    expect(maskCelularTitular('abc')).toBeNull();
  });
  it('menos de 4 dígitos ⇒ máscara total', () => {
    expect(maskCelularTitular('123')).toBe('(**) *****-****');
  });
  it('nunca contém o número completo', () => {
    const raw = '11987654321';
    expect(maskCelularTitular(raw)).not.toContain(raw);
    expect(maskCelularTitular(raw)).not.toContain('1198765');
  });
});
