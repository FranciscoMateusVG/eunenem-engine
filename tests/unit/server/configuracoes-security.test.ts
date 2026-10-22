import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configuracoesRouter } from '../../../apps/eunenem-server/server/trpc/configuracoes-router.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { PermissaoCampanhaNegadaError } from '../../../apps/eunenem-server/server/trpc/exigir-permissao-campanha.js';
import { CampanhaAcessoNegadoError } from '../../../apps/eunenem-server/server/trpc/resolve-campanha-administrada.js';
import { SessaoNaoAutenticadaError } from '../../../apps/eunenem-server/server/trpc/session-resolver.js';

const mocks = vi.hoisted(() => ({ user: vi.fn(), resolve: vi.fn(), manage: vi.fn() }));
vi.mock('../../../apps/eunenem-server/server/trpc/session-resolver.js', async (original) => ({
  ...(await original<object>()),
  resolverUsuarioAutenticado: mocks.user,
}));
vi.mock(
  '../../../apps/eunenem-server/server/trpc/resolve-campanha-administrada.js',
  async (original) => ({
    ...(await original<object>()),
    resolverCampanhaAdministrada: mocks.resolve,
  }),
);
vi.mock(
  '../../../apps/eunenem-server/server/trpc/exigir-permissao-campanha.js',
  async (original) => ({
    ...(await original<object>()),
    resolverCampanhaComPermissao: mocks.manage,
  }),
);
const id = '11111111-1111-4111-8111-111111111111';
const actor = { usuario: { id, idConta: id, idPlataforma: id }, campanha: { id } };
const now = new Date('2026-10-21T12:00:00Z');
function rig(age = 0, principal = id) {
  const writes = vi.fn();
  const ctx = {
    headers: new Headers(),
    resHeaders: new Headers(),
    deps: {
      db: { executeQuery: writes },
      clock: () => now,
      auth: {
        api: {
          getSession: async () => ({
            user: { id: principal },
            session: { createdAt: new Date(now.getTime() - age) },
          }),
        },
      },
      pagamentoRepository: {
        findById: async () => ({ intencao: { idCampanha: 'foreign' }, status: 'aprovado' }),
      },
    },
  } as unknown as TrpcContext;
  return { caller: configuracoesRouter.createCaller(ctx), writes };
}
beforeEach(() => {
  mocks.user.mockReset().mockResolvedValue(actor);
  mocks.resolve.mockReset().mockResolvedValue(actor);
  mocks.manage.mockReset().mockResolvedValue(actor);
});
describe('Configurações: tenant, grants and fresh-account confirmation', () => {
  it('rejects anonymous requests before preferences or deletion storage', async () => {
    mocks.user.mockRejectedValue(new SessaoNaoAutenticadaError('sem_sessao'));
    const { caller, writes } = rig();
    await expect(caller.get({ idCampanha: id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(writes).not.toHaveBeenCalled();
  });
  it('denies foreign campaigns and members without message-management permission', async () => {
    const { caller } = rig();
    mocks.resolve.mockRejectedValue(new CampanhaAcessoNegadoError('foreign'));
    await expect(caller.get({ idCampanha: id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    mocks.manage.mockRejectedValue(new PermissaoCampanhaNegadaError('mensagens:gerenciar'));
    await expect(caller.privacidade({ idCampanha: id, exibirRecados: true })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
  });
  it('never moderates a payment belonging to another campaign', async () => {
    const { caller, writes } = rig();
    await expect(
      caller.moderar({ idCampanha: id, idPagamento: id, aprovado: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(writes).not.toHaveBeenCalled();
  });
  it.each([16 * 60_000, -1])('rejects stale or future authentication age %s', async (age) => {
    const { caller, writes } = rig(age);
    await expect(
      caller.solicitarExclusao({ confirmacao: 'SOLICITAR EXCLUSAO' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(writes).not.toHaveBeenCalled();
  });
  it('requires the recent principal to be the same authenticated account', async () => {
    const { caller, writes } = rig(0, '22222222-2222-4222-8222-222222222222');
    await expect(
      caller.solicitarExclusao({ confirmacao: 'SOLICITAR EXCLUSAO' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(writes).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation', async () => {
    const { caller, writes } = rig();
    await expect(caller.solicitarExclusao({ confirmacao: '' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(writes).not.toHaveBeenCalled();
  });
});
