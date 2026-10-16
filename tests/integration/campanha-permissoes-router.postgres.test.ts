/**
 * aperture-1z18g — server-side per-action permission guards, driven through
 * the REAL tRPC router (authenticated session cookie → appRouter caller) with
 * Postgres-backed campanha / membros / recebedor / contribuição / livro repos.
 *
 * Every guarded route gets: owner allowed; membro WITHOUT the grant denied
 * (FORBIDDEN, i.e. a direct API call can't bypass the hidden UI); membro WITH
 * the grant allowed; revocation effective on the very next call; outsider
 * still UNAUTHORIZED (non-leaking).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaMembrosRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-membros-repository.postgres.js';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { ResgatePendenteRepositoryPostgres } from '../../src/adapters/arrecadacao/resgate-pendente-repository.postgres.js';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { AuthServiceMemoria } from '../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import type { DadosRecebedorPix } from '../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
import type { AcaoConcedivel } from '../../src/domain/arrecadacao/value-objects/permissao-campanha.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import type { Observability } from '../../src/observability/observability.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { criarSessaoUsuario } from '../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const SESSION_COOKIE = 'better-auth.session_token';
const TEST_PASSWORD = 'senha-teste-123';

const PIX: DadosRecebedorPix = {
  metodo: 'pix',
  nomeTitular: 'Maria Silva',
  cpfTitular: '52998224725',
  tipoChavePix: 'email',
  chavePix: 'maria@exemplo.com',
};

type Caller = ReturnType<typeof appRouter.createCaller>;

let testDb: TestDatabase;
let deps: ServerDeps;
let authService: AuthServiceMemoria;
let plataformaRepository: PlataformaRepositoryMemory;

const observability: Observability = { logger: new NoopLogger(), tracer: noopTracer() };

beforeAll(async () => {
  testDb = await createTestDatabase();
  const db = testDb.db;
  authService = new AuthServiceMemoria();
  plataformaRepository = new PlataformaRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  const pagamentoRepository = new PagamentoRepositoryPostgres(db);
  deps = {
    db,
    auth: {} as never,
    authService,
    usuarioRepository: new UsuarioRepositoryPostgres(db),
    plataformaRepository,
    campanhaRepository: new CampanhaRepositoryPostgres(db, recebedorRepository),
    campanhaMembrosRepository: new CampanhaMembrosRepositoryPostgres(db),
    contribuicaoRepository: new ContribuicaoRepositoryPostgres(db),
    recebedorRepository,
    resgatePendenteRepository: new ResgatePendenteRepositoryPostgres(db),
    pagamentoRepository,
    livroFinanceiroRepository: new LivroFinanceiroRepositoryPostgres(db, recebedorRepository),
    observability,
    clock: () => new Date('2026-10-16T12:00:00.000Z'),
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
  } as unknown as ServerDeps;
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

async function registrar(): Promise<{
  caller: Caller;
  idConta: string;
  idCampanha: string;
  headers: Headers;
  idUsuario: string;
}> {
  const idUsuario = randomUUID();
  const idConta = randomUUID();
  const email = `perm-${idUsuario}@example.com`;
  const registro = await registrarContaUsuario(
    {
      usuarioRepository: deps.usuarioRepository,
      plataformaRepository,
      campanhaRepository: deps.campanhaRepository,
      recebedorRepository: deps.recebedorRepository,
      authService,
      clock: deps.clock,
      observability,
    },
    {
      idUsuario,
      idConta,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email,
      nomeExibicao: 'Pessoa',
      senhaSimulada: TEST_PASSWORD,
    },
  );
  const sessao = await criarSessaoUsuario(
    { usuarioRepository: deps.usuarioRepository, authService, observability },
    { idPlataforma: ID_PLATAFORMA_EUNENEM, email, senhaSimulada: TEST_PASSWORD },
  );
  const ctx: TrpcContext = {
    deps,
    headers: new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessao.token)}` }),
    resHeaders: new Headers(),
  };
  return {
    caller: appRouter.createCaller(ctx),
    idConta,
    idCampanha: registro.campanha.id,
    headers: ctx.headers,
    idUsuario,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? `THREW:${(err as Error).message}`;
  }
}

describe('per-action permission guards (Postgres, real router)', () => {
  let owner: Awaited<ReturnType<typeof registrar>>;
  let membro: Awaited<ReturnType<typeof registrar>>;
  let estranho: Awaited<ReturnType<typeof registrar>>;
  let idCampanha: string;

  const conceder = (permissoes: AcaoConcedivel[]) =>
    owner.caller.campanhaMembros.definirPermissoes({
      idCampanha,
      idConta: membro.idConta,
      permissoes,
    });

  beforeEach(async () => {
    owner = await registrar();
    membro = await registrar();
    estranho = await registrar();
    idCampanha = owner.idCampanha;
    await deps.campanhaRepository.adicionarAdministrador(idCampanha, membro.idConta);
  });

  describe('recebedor:gerenciar', () => {
    it('recebedor.criar: owner ok; membro denied until granted; outsider UNAUTHORIZED', async () => {
      expect(await codeOf(membro.caller.recebedor.criar({ idCampanha, dadosRecebedor: PIX }))).toBe(
        'FORBIDDEN',
      );
      expect(
        await codeOf(estranho.caller.recebedor.criar({ idCampanha, dadosRecebedor: PIX })),
      ).toBe('UNAUTHORIZED');
      await conceder(['recebedor:gerenciar']);
      expect(await codeOf(membro.caller.recebedor.criar({ idCampanha, dadosRecebedor: PIX }))).toBe(
        'OK',
      );
    });

    it('recebedor.criar: owner always allowed', async () => {
      expect(await codeOf(owner.caller.recebedor.criar({ idCampanha, dadosRecebedor: PIX }))).toBe(
        'OK',
      );
    });

    it('recebedor.atualizar (create + edit branches) and revocation is immediate', async () => {
      expect(
        await codeOf(membro.caller.recebedor.atualizar({ idCampanha, dadosRecebedor: PIX })),
      ).toBe('FORBIDDEN');
      await conceder(['recebedor:gerenciar']);
      expect(
        await codeOf(membro.caller.recebedor.atualizar({ idCampanha, dadosRecebedor: PIX })),
      ).toBe('OK');
      await conceder([]);
      expect(
        await codeOf(
          membro.caller.recebedor.atualizar({
            idCampanha,
            dadosRecebedor: { ...PIX, chavePix: 'outra@exemplo.com' },
          }),
        ),
      ).toBe('FORBIDDEN');
      const salvo = await deps.recebedorRepository.findAtivoByCampanhaId(idCampanha);
      expect(salvo?.dadosRecebedor).toMatchObject({ chavePix: 'maria@exemplo.com' });
    });

    it('recebedor.get hides bank data from members without the grant; status stays visible', async () => {
      await owner.caller.recebedor.criar({ idCampanha, dadosRecebedor: PIX });
      expect(await codeOf(membro.caller.recebedor.get({ idCampanha }))).toBe('FORBIDDEN');
      expect(await membro.caller.recebedor.status({ idCampanha })).toEqual({
        configurado: true,
        metodo: 'pix',
      });
      expect(await owner.caller.recebedor.get({ idCampanha })).toMatchObject({
        cpfTitular: PIX.cpfTitular,
      });
      await conceder(['recebedor:gerenciar']);
      expect(await membro.caller.recebedor.get({ idCampanha })).toMatchObject({
        chavePix: PIX.chavePix,
      });
      expect(await codeOf(estranho.caller.recebedor.status({ idCampanha }))).toBe('UNAUTHORIZED');
    });

    it('recebedor.marcarResgatePendente is gated by recebedor:gerenciar', async () => {
      expect(await codeOf(membro.caller.recebedor.marcarResgatePendente({ idCampanha }))).toBe(
        'FORBIDDEN',
      );
      await conceder(['recebedor:gerenciar']);
      expect(await codeOf(membro.caller.recebedor.marcarResgatePendente({ idCampanha }))).toBe(
        'OK',
      );
    });
  });

  describe('saque:solicitar', () => {
    it('recebedor.transferencia.solicitar: membro denied before ANY saldo/recebedor check', async () => {
      await owner.caller.recebedor.criar({ idCampanha, dadosRecebedor: PIX });
      expect(await codeOf(membro.caller.recebedor.transferencia.solicitar({ idCampanha }))).toBe(
        'FORBIDDEN',
      );
      // Other grants don't leak into saque.
      await conceder(['recebedor:gerenciar', 'presentes:gerenciar']);
      expect(await codeOf(membro.caller.recebedor.transferencia.solicitar({ idCampanha }))).toBe(
        'FORBIDDEN',
      );
      await conceder(['saque:solicitar']);
      // Past the guard: now the business rule answers (no saldo yet).
      expect(
        await codeOf(membro.caller.recebedor.transferencia.solicitar({ idCampanha })),
      ).not.toBe('FORBIDDEN');
      expect(await codeOf(owner.caller.recebedor.transferencia.solicitar({ idCampanha }))).not.toBe(
        'FORBIDDEN',
      );
    });
  });

  describe('presentes:gerenciar', () => {
    it('contribuicao create / createBulk / update / delete', async () => {
      const item = { nome: 'Berço', valor: 15000, quantidade: 1 };
      expect(await codeOf(membro.caller.contribuicao.create({ idCampanha, ...item }))).toBe(
        'FORBIDDEN',
      );
      expect(
        await codeOf(membro.caller.contribuicao.createBulk({ idCampanha, items: [item] })),
      ).toBe('FORBIDDEN');

      const criado = await owner.caller.contribuicao.create({ idCampanha, ...item });
      const id = criado.ids[0] as string;

      expect(
        await codeOf(membro.caller.contribuicao.update({ idCampanha, id, nome: 'Hackeado' })),
      ).toBe('FORBIDDEN');
      expect(await codeOf(membro.caller.contribuicao.delete({ idCampanha, ids: [id] }))).toBe(
        'FORBIDDEN',
      );
      // Read stays open to every admin.
      expect(await codeOf(membro.caller.contribuicao.list({ idCampanha }))).toBe('OK');

      await conceder(['presentes:gerenciar']);
      expect(
        await codeOf(membro.caller.contribuicao.update({ idCampanha, id, nome: 'Berço novo' })),
      ).toBe('OK');
      expect(await codeOf(membro.caller.contribuicao.create({ idCampanha, ...item }))).toBe('OK');
      expect(await codeOf(membro.caller.contribuicao.delete({ idCampanha, ids: [id] }))).toBe('OK');

      await conceder([]);
      expect(await codeOf(membro.caller.contribuicao.create({ idCampanha, ...item }))).toBe(
        'FORBIDDEN',
      );
    });

    it('emitirUrlUploadImagemItem is gated before storage is touched', async () => {
      expect(
        await codeOf(
          membro.caller.contribuicao.emitirUrlUploadImagemItem({
            idCampanha,
            contentType: 'image/png',
          }),
        ),
      ).toBe('FORBIDDEN');
    });
  });

  describe('membros:gerenciar (owner-only)', () => {
    it('owner lists members with roles and grants', async () => {
      await conceder(['presentes:gerenciar']);
      const membros = await owner.caller.campanhaMembros.listar({ idCampanha });
      expect(membros.map((m) => [m.idConta, m.papel, m.permissoes])).toEqual([
        [owner.idConta, 'owner', ['recebedor:gerenciar', 'saque:solicitar', 'presentes:gerenciar']],
        [membro.idConta, 'membro', ['presentes:gerenciar']],
      ]);
    });

    it('a membro can neither list nor grant — not even to itself, not even with every grant', async () => {
      await conceder(['recebedor:gerenciar', 'saque:solicitar', 'presentes:gerenciar']);
      expect(await codeOf(membro.caller.campanhaMembros.listar({ idCampanha }))).toBe('FORBIDDEN');
      await conceder([]);
      expect(
        await codeOf(
          membro.caller.campanhaMembros.definirPermissoes({
            idCampanha,
            idConta: membro.idConta,
            permissoes: ['saque:solicitar'],
          }),
        ),
      ).toBe('FORBIDDEN');
      const acesso = await deps.campanhaMembrosRepository.obterAcesso(idCampanha, membro.idConta);
      expect(acesso?.permissoes).toEqual([]);
    });

    it('membros:gerenciar can never be granted; owner rows cannot be edited', async () => {
      expect(
        await codeOf(
          owner.caller.campanhaMembros.definirPermissoes({
            idCampanha,
            idConta: membro.idConta,
            permissoes: ['membros:gerenciar' as AcaoConcedivel],
          }),
        ),
      ).toBe('BAD_REQUEST');
      expect(
        await codeOf(
          owner.caller.campanhaMembros.definirPermissoes({
            idCampanha,
            idConta: owner.idConta,
            permissoes: [],
          }),
        ),
      ).toBe('NOT_FOUND');
    });

    it('outsider and cross-campaign attempts are UNAUTHORIZED', async () => {
      expect(await codeOf(estranho.caller.campanhaMembros.listar({ idCampanha }))).toBe(
        'UNAUTHORIZED',
      );
      // Owner of ANOTHER campaign can't grant on this one.
      expect(
        await codeOf(
          estranho.caller.campanhaMembros.definirPermissoes({
            idCampanha,
            idConta: membro.idConta,
            permissoes: ['saque:solicitar'],
          }),
        ),
      ).toBe('UNAUTHORIZED');
    });

    it('remover: owner removes a membro; access dies on the next call; invite hook runs in the trx', async () => {
      const chamadas: unknown[] = [];
      const depsComHook = {
        ...deps,
        revogarConvitesPendentesDoMembro: async (
          input: { idCampanha: string; idConta: string; idUsuarioAtor: string },
          context: { trx: unknown },
        ) => {
          // Runs under the campanha lock: the membership is still there.
          const ainda = await deps.campanhaMembrosRepository.obterAcesso(
            input.idCampanha,
            input.idConta,
            context as never,
          );
          chamadas.push({ ...input, temTrx: context.trx !== undefined, aindaMembro: ainda?.papel });
        },
      } as ServerDeps;
      const ownerComHook = appRouter.createCaller({
        deps: depsComHook,
        headers: owner.headers,
        resHeaders: new Headers(),
      });
      await conceder(['presentes:gerenciar']);
      await ownerComHook.campanhaMembros.remover({ idCampanha, idConta: membro.idConta });
      expect(chamadas).toEqual([
        {
          idCampanha,
          idConta: membro.idConta,
          idUsuarioAtor: owner.idUsuario,
          temTrx: true,
          aindaMembro: 'membro',
        },
      ]);
      expect(
        await deps.campanhaMembrosRepository.obterAcesso(idCampanha, membro.idConta),
      ).toBeUndefined();
      expect(
        await codeOf(
          membro.caller.contribuicao.create({ idCampanha, nome: 'x', valor: 15000, quantidade: 1 }),
        ),
      ).toBe('UNAUTHORIZED');
      // Re-adding starts from zero grants.
      await deps.campanhaRepository.adicionarAdministrador(idCampanha, membro.idConta);
      expect(
        (await deps.campanhaMembrosRepository.obterAcesso(idCampanha, membro.idConta))?.permissoes,
      ).toEqual([]);
    });

    it('remover: membro cannot remove anyone (incl. itself); owner cannot be removed; outsider UNAUTHORIZED', async () => {
      await conceder(['recebedor:gerenciar', 'saque:solicitar', 'presentes:gerenciar']);
      expect(
        await codeOf(membro.caller.campanhaMembros.remover({ idCampanha, idConta: owner.idConta })),
      ).toBe('FORBIDDEN');
      expect(
        await codeOf(
          membro.caller.campanhaMembros.remover({ idCampanha, idConta: membro.idConta }),
        ),
      ).toBe('FORBIDDEN');
      expect(
        await codeOf(owner.caller.campanhaMembros.remover({ idCampanha, idConta: owner.idConta })),
      ).toBe('BAD_REQUEST');
      expect(
        await codeOf(
          estranho.caller.campanhaMembros.remover({ idCampanha, idConta: membro.idConta }),
        ),
      ).toBe('UNAUTHORIZED');
      expect(
        await codeOf(
          owner.caller.campanhaMembros.remover({ idCampanha, idConta: estranho.idConta }),
        ),
      ).toBe('NOT_FOUND');
      expect((await deps.campanhaMembrosRepository.listarMembros(idCampanha)).length).toBe(2);
    });

    it('meuAcesso reports effective actions for the UI', async () => {
      expect(await owner.caller.campanhaMembros.meuAcesso({ idCampanha })).toEqual({
        papel: 'owner',
        acoes: [
          'recebedor:gerenciar',
          'saque:solicitar',
          'presentes:gerenciar',
          'membros:gerenciar',
        ],
      });
      await conceder(['saque:solicitar']);
      expect(await membro.caller.campanhaMembros.meuAcesso({ idCampanha })).toEqual({
        papel: 'membro',
        acoes: ['saque:solicitar'],
      });
      expect(await codeOf(estranho.caller.campanhaMembros.meuAcesso({ idCampanha }))).toBe(
        'UNAUTHORIZED',
      );
    });
  });
});
