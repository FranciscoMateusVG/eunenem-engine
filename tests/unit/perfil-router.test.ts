/**
 * Tests for aperture-cdo69 — perfil tRPC router.
 *
 * Covers:
 *   (A) perfil.atualizar persists + perfil.getPerfil returns what was saved
 *       (incl. nomeExibicao=creatorName round-trip through atualizarPerfilUsuario)
 *   (B) perfil.getPerfilPublicoBySlug returns the projection AND a dedicated
 *       PII-anti-leak assertion: the public payload contains NO email,
 *       idConta, idUsuario, idPlataforma, or any other internal id
 *   (C) unknown slug → NOT_FOUND
 *   (D) auth gating — getPerfil / atualizar without a session → UNAUTHORIZED
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import { PerfilCriadorRepositoryMemory } from '../../src/adapters/usuario/perfil-criador-repository.memory.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import { noopTracer } from '../../src/observability/tracer.js';

const SESSION_COOKIE = 'better-auth.session_token';
const SESSION_TOKEN = 'tok_test_session';
const FAKE_NOW = new Date('2026-06-23T12:00:00.000Z');
const SLUG = 'helena';
const EMAIL = 'helena@example.com';

interface Rig {
  caller: ReturnType<typeof appRouter.createCaller>;
  callerAnon: ReturnType<typeof appRouter.createCaller>;
  idUsuario: string;
  idConta: string;
}

async function buildRig(): Promise<Rig> {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const usuarioRepository = new UsuarioRepositoryMemory();
  const perfilCriadorRepository = new PerfilCriadorRepositoryMemory();

  const idUsuario = randomUUID();
  const idConta = randomUUID();
  await usuarioRepository.saveRegistroDomain({
    usuario: {
      id: idUsuario as never,
      idPlataforma: ID_PLATAFORMA_EUNENEM as never,
      idConta: idConta as never,
      email: EMAIL as never,
      nomeExibicao: 'Nome Antigo' as never,
      slug: SLUG as never,
      criadoEm: FAKE_NOW,
      tutorialCompletadoEm: null,
    },
    conta: {
      id: idConta as never,
      idUsuario: idUsuario as never,
      permissoes: [],
      criadaEm: FAKE_NOW,
    },
  });

  const authService = {
    validarSessao: async (token: string) =>
      token === SESSION_TOKEN
        ? { idUsuario: idUsuario as never, token, expiresAt: new Date(Date.now() + 3600_000) }
        : null,
  };

  const deps = {
    db: {} as never,
    auth: {} as never,
    authService: authService as never,
    usuarioRepository,
    perfilCriadorRepository,
    plataformaRepository: {} as never,
    observability,
    clock: () => FAKE_NOW,
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaa',
  } as unknown as ServerDeps;

  const authedHeaders = new Headers();
  authedHeaders.set('cookie', `${SESSION_COOKIE}=${encodeURIComponent(SESSION_TOKEN)}`);
  const ctxAuthed: TrpcContext = { deps, headers: authedHeaders, resHeaders: new Headers() };
  const ctxAnon: TrpcContext = { deps, headers: new Headers(), resHeaders: new Headers() };

  return {
    caller: appRouter.createCaller(ctxAuthed),
    callerAnon: appRouter.createCaller(ctxAnon),
    idUsuario,
    idConta,
  };
}

const FULL_INPUT = {
  nomeExibicao: 'Helena Mãe',
  nomeBebe: 'Helena',
  relacao: 'Mãe',
  historia: 'Uma espera cheia de amor.',
  dataNascimento: new Date('2026-09-15T00:00:00.000Z'),
  tipoEvento: 'cha-bebe' as const,
  dataEvento: new Date('2026-08-01T00:00:00.000Z'),
  fotoPerfilKey: 'perfis/helena/perfil.jpg',
  fotoCapaKey: null,
  fotoHistoriaKey: null,
};

describe('perfil router', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await buildRig();
  });

  it('atualizar persists and getPerfil returns the saved profile + creatorName', async () => {
    await rig.caller.perfil.atualizar(FULL_INPUT);
    const got = await rig.caller.perfil.getPerfil();
    expect(got.creatorName).toBe('Helena Mãe'); // nomeExibicao updated via atualizarPerfilUsuario
    expect(got.slug).toBe(SLUG);
    expect(got.nomeBebe).toBe('Helena');
    expect(got.relacao).toBe('Mãe');
    expect(got.historia).toBe('Uma espera cheia de amor.');
    expect(got.tipoEvento).toBe('cha-bebe');
    expect(got.dataEvento).toBe('2026-08-01T00:00:00.000Z');
    expect(got.dataNascimento).toBe('2026-09-15T00:00:00.000Z');
    expect(got.fotoPerfil).toBe('perfis/helena/perfil.jpg');
  });

  it('getPerfilPublicoBySlug returns the projection', async () => {
    await rig.caller.perfil.atualizar(FULL_INPUT);
    const pub = await rig.callerAnon.perfil.getPerfilPublicoBySlug({ slug: SLUG });
    expect(pub.creatorName).toBe('Helena Mãe');
    expect(pub.nomeBebe).toBe('Helena');
    expect(pub.historia).toBe('Uma espera cheia de amor.');
    expect(pub.tipoEvento).toBe('cha-bebe');
    expect(pub.slug).toBe(SLUG);
  });

  it('🔒 public projection leaks NO PII (email / idConta / idUsuario / idPlataforma)', async () => {
    await rig.caller.perfil.atualizar(FULL_INPUT);
    const pub = await rig.callerAnon.perfil.getPerfilPublicoBySlug({ slug: SLUG });

    // 1. Key-level: only the whitelisted public keys are present.
    expect(Object.keys(pub).sort()).toEqual(
      [
        'creatorName',
        'dataEvento',
        'dataNascimento',
        'fotoCapa',
        'fotoHistoria',
        'fotoPerfil',
        'historia',
        'nomeBebe',
        'relacao',
        'slug',
        'tipoEvento',
      ].sort(),
    );

    // 2. Value-level: no internal identifier or email appears anywhere in the
    // serialized payload, even nested.
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain(rig.idUsuario);
    expect(serialized).not.toContain(rig.idConta);
    expect(serialized).not.toContain(ID_PLATAFORMA_EUNENEM);
    for (const forbidden of ['email', 'idConta', 'idUsuario', 'idPlataforma']) {
      expect(pub).not.toHaveProperty(forbidden);
    }
  });

  it('getPerfilPublicoBySlug unknown slug → NOT_FOUND', async () => {
    await expect(
      rig.callerAnon.perfil.getPerfilPublicoBySlug({ slug: 'inexistente' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('getPerfil without session → UNAUTHORIZED', async () => {
    await expect(rig.callerAnon.perfil.getPerfil()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('atualizar without session → UNAUTHORIZED', async () => {
    await expect(rig.callerAnon.perfil.atualizar(FULL_INPUT)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('getPerfil for a user with no profile yet → all-null content', async () => {
    const got = await rig.caller.perfil.getPerfil();
    expect(got.creatorName).toBe('Nome Antigo');
    expect(got.slug).toBe(SLUG);
    expect(got.nomeBebe).toBeNull();
    expect(got.historia).toBeNull();
    expect(got.fotoPerfil).toBeNull();
  });
});
