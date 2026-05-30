import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { AuthServiceMemoria } from '../../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import { TokenSessaoSchema } from '../../../src/domain/usuario/value-objects/token-sessao.js';
import { UsuarioEmailJaExisteError } from '../../../src/errors/usuario/email-ja-existe.error.js';
import { UsuarioInputInvalidoError } from '../../../src/errors/usuario/input-invalido.error.js';
import { UsuarioNaoAutorizadoError } from '../../../src/errors/usuario/nao-autorizado.error.js';
import { UsuarioPlataformaNaoEncontradaError } from '../../../src/errors/usuario/plataforma-nao-encontrada.error.js';
import { UsuarioSessaoInvalidaError } from '../../../src/errors/usuario/sessao-invalida.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { atualizarPerfilUsuario } from '../../../src/use-cases/usuario/atualizar-perfil-usuario.js';
import { autorizarPermissaoUsuario } from '../../../src/use-cases/usuario/autorizar-permissao-usuario.js';
import { criarSessaoUsuario } from '../../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../../src/use-cases/usuario/registrar-conta-usuario.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

function makeUsuarioRepos(authServiceOpts: { sessionTtlMs?: number } = {}) {
  return {
    usuarioRepository: new UsuarioRepositoryMemory(),
    plataformaRepository: new PlataformaRepositoryMemory(),
    authService: new AuthServiceMemoria({
      clock,
      sessionTtlMs: authServiceOpts.sessionTtlMs ?? 60_000,
    }),
  };
}

describe('registrarContaUsuario', () => {
  it('registers user, account and simulated credential scoped to plataforma', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    const idUsuario = randomUUID();
    const idConta = randomUUID();

    const result = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta,
        email: 'creator@example.com',
        nomeExibicao: 'Campaign Owner',
        senhaSimulada: 'not-a-real-password',
      },
    );

    expect(result.usuario.id).toBe(idUsuario);
    expect(result.usuario.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(result.conta.id).toBe(idConta);
    expect(result.conta.permissoes).toEqual(['campaign:admin']);
    expect(
      await usuarioRepository.findUsuarioByEmail(ID_PLATAFORMA_EUNENEM, 'creator@example.com'),
    ).toEqual(result.usuario);
  });

  it('throws UsuarioPlataformaNaoEncontradaError when idPlataforma is unknown', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    await expect(
      registrarContaUsuario(
        {
          usuarioRepository,
          plataformaRepository,
          authService,
          clock,
          observability: silentObservability,
        },
        {
          idUsuario: randomUUID(),
          idPlataforma: '99999999-9999-4999-8999-999999999999',
          idConta: randomUUID(),
          email: 'ghost@example.com',
          nomeExibicao: 'Ghost',
          senhaSimulada: 'p',
        },
      ),
    ).rejects.toThrow(UsuarioPlataformaNaoEncontradaError);
  });

  it('throws UsuarioInputInvalidoError on invalid email', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    await expect(
      registrarContaUsuario(
        {
          usuarioRepository,
          plataformaRepository,
          authService,
          clock,
          observability: silentObservability,
        },
        {
          idUsuario: randomUUID(),
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idConta: randomUUID(),
          email: 'not-an-email',
          nomeExibicao: 'X',
          senhaSimulada: 'p',
        },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });

  it('throws UsuarioEmailJaExisteError when email is taken on the same plataforma', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    const email = 'taken@example.com';
    await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email,
        nomeExibicao: 'One',
        senhaSimulada: 'p',
      },
    );

    await expect(
      registrarContaUsuario(
        {
          usuarioRepository,
          plataformaRepository,
          authService,
          clock,
          observability: silentObservability,
        },
        {
          idUsuario: randomUUID(),
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idConta: randomUUID(),
          email,
          nomeExibicao: 'Two',
          senhaSimulada: 'p',
        },
      ),
    ).rejects.toThrow(UsuarioEmailJaExisteError);
  });

  it('allows the same email across different plataformas (two distinct accounts)', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    const email = 'multi@example.com';

    const eunenem = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email,
        nomeExibicao: 'On Eunenem',
        senhaSimulada: 'p',
      },
    );

    const eucasei = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        idConta: randomUUID(),
        email,
        nomeExibicao: 'On Eucasei',
        senhaSimulada: 'p',
      },
    );

    expect(eunenem.usuario.id).not.toBe(eucasei.usuario.id);
    expect(eunenem.usuario.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(eucasei.usuario.idPlataforma).toBe(ID_PLATAFORMA_EUCASEI);
  });

  // --- slug derivation + collision (aperture-khbow) ---

  it('derives slug from first word of nomeExibicao (stripping diacritics)', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();

    const result = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email: 'andre@example.com',
        nomeExibicao: 'André Souza',
        senhaSimulada: 'p',
      },
    );

    expect(result.usuario.slug).toBe('andre');
    expect((await usuarioRepository.findUsuarioBySlug(ID_PLATAFORMA_EUNENEM, 'andre'))?.id).toBe(
      result.usuario.id,
    );
  });

  it('suffixes the slug with -N on intra-plataforma collisions', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();

    const helena1 = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email: 'helena1@example.com',
        nomeExibicao: 'Helena Silva',
        senhaSimulada: 'p',
      },
    );

    const helena2 = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email: 'helena2@example.com',
        nomeExibicao: 'Helena Costa',
        senhaSimulada: 'p',
      },
    );

    const helena3 = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email: 'helena3@example.com',
        nomeExibicao: 'Helena Lima',
        senhaSimulada: 'p',
      },
    );

    expect(helena1.usuario.slug).toBe('helena');
    expect(helena2.usuario.slug).toBe('helena-2');
    expect(helena3.usuario.slug).toBe('helena-3');
  });

  it('allows the same slug across different plataformas (multi-tenant)', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();

    const onEunenem = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email: 'helena@eunenem.example',
        nomeExibicao: 'Helena',
        senhaSimulada: 'p',
      },
    );

    const onEucasei = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        idConta: randomUUID(),
        email: 'helena@eucasei.example',
        nomeExibicao: 'Helena',
        senhaSimulada: 'p',
      },
    );

    expect(onEunenem.usuario.slug).toBe('helena');
    expect(onEucasei.usuario.slug).toBe('helena'); // same slug, different plataforma → fine
  });

  it('falls back to "usuario" / "usuario-2" when name yields no valid base', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();

    const a = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email: 'a@example.com',
        nomeExibicao: 'X', // single char → fallback "usuario"
        senhaSimulada: 'p',
      },
    );

    const b = await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email: 'b@example.com',
        nomeExibicao: '123', // digits-only → fallback "usuario", collides with a
        senhaSimulada: 'p',
      },
    );

    expect(a.usuario.slug).toBe('usuario');
    expect(b.usuario.slug).toBe('usuario-2');
  });

  it('compensates the AuthService write when saveRegistroDomain throws (T3 saga)', async () => {
    // Stage: a user already exists in the domain repo for (plataforma, email)
    // but NOT in the AuthService. Then attempt a second registration that
    // collides at the domain layer AFTER auth.criarConta succeeded.
    //
    // The use-case's pre-check (findUsuarioByEmail) catches the collision
    // BEFORE auth — so to drive the compensation path we need to make
    // saveRegistroDomain itself fail post-pre-check. Easiest way: wrap
    // the repo with a saveRegistroDomain that throws on the first call.
    const { plataformaRepository, authService } = makeUsuarioRepos();
    const baseRepo = new UsuarioRepositoryMemory();
    const repoWithFailingSave = {
      ...baseRepo,
      saveRegistroDomain: () => Promise.reject(new Error('domain write blew up')),
      findUsuarioById: baseRepo.findUsuarioById.bind(baseRepo),
      findUsuarioByEmail: baseRepo.findUsuarioByEmail.bind(baseRepo),
      findUsuarioBySlug: baseRepo.findUsuarioBySlug.bind(baseRepo),
      findContaById: baseRepo.findContaById.bind(baseRepo),
      atualizarNomeExibicaoUsuario: baseRepo.atualizarNomeExibicaoUsuario.bind(baseRepo),
    };

    const idUsuario = randomUUID();
    const email = 'compensate@example.com';

    await expect(
      registrarContaUsuario(
        {
          usuarioRepository: repoWithFailingSave,
          plataformaRepository,
          authService,
          clock,
          observability: silentObservability,
        },
        {
          idUsuario,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idConta: randomUUID(),
          email,
          nomeExibicao: 'Bob',
          senhaSimulada: 'p',
        },
      ),
    ).rejects.toThrow('domain write blew up');

    // The compensation MUST have torn down the auth principal. We verify
    // by attempting to sign in with the credentials we created — if
    // compensation ran, this fails (no such auth principal).
    await expect(
      authService.iniciarSessao({
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email,
        senha: 'p',
      }),
    ).rejects.toThrow(UsuarioInputInvalidoError);

    // And we should be able to re-register with the same email + idUsuario
    // since the auth-side row was cleaned up.
    await expect(
      registrarContaUsuario(
        {
          usuarioRepository: new UsuarioRepositoryMemory(),
          plataformaRepository,
          authService,
          clock,
          observability: silentObservability,
        },
        {
          idUsuario,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idConta: randomUUID(),
          email,
          nomeExibicao: 'Bob retry',
          senhaSimulada: 'p',
        },
      ),
    ).resolves.toBeDefined();
  });
});

describe('atualizarPerfilUsuario', () => {
  it('updates display name', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta,
        email: 'u@example.com',
        nomeExibicao: 'Before',
        senhaSimulada: 'p',
      },
    );

    const updated = await atualizarPerfilUsuario(
      { usuarioRepository, observability: silentObservability },
      { idUsuario, nomeExibicao: 'After' },
    );

    expect(updated.nomeExibicao).toBe('After');
  });

  it('throws when user is missing', async () => {
    const { usuarioRepository } = makeUsuarioRepos();
    await expect(
      atualizarPerfilUsuario(
        { usuarioRepository, observability: silentObservability },
        { idUsuario: randomUUID(), nomeExibicao: 'Ghost' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });

  it('throws UsuarioInputInvalidoError on invalid profile input', async () => {
    const { usuarioRepository } = makeUsuarioRepos();
    await expect(
      atualizarPerfilUsuario(
        { usuarioRepository, observability: silentObservability },
        { idUsuario: randomUUID(), nomeExibicao: '' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });
});

describe('criarSessaoUsuario', () => {
  it('creates a plataforma-scoped session when simulated password matches', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    const email = 'login@example.com';
    const password = 'secret-stub';
    await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email,
        nomeExibicao: 'L',
        senhaSimulada: password,
      },
    );

    const sessao = await criarSessaoUsuario(
      {
        usuarioRepository,
        authService,
        observability: silentObservability,
      },
      { idPlataforma: ID_PLATAFORMA_EUNENEM, email, senhaSimulada: password },
    );

    expect(sessao.token.length).toBeGreaterThanOrEqual(32);
    expect(sessao.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(sessao.expiraEm.getTime()).toBe(fixedDate.getTime() + 60_000);
  });

  it('refuses to log in against a plataforma where the email is not registered', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    const email = 'only-eunenem@example.com';
    await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email,
        nomeExibicao: 'X',
        senhaSimulada: 'right',
      },
    );

    await expect(
      criarSessaoUsuario(
        {
          usuarioRepository,
          authService,
          observability: silentObservability,
        },
        { idPlataforma: ID_PLATAFORMA_EUCASEI, email, senhaSimulada: 'right' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });

  it('throws on bad credentials', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta: randomUUID(),
        email: 'only@example.com',
        nomeExibicao: 'L',
        senhaSimulada: 'right',
      },
    );

    await expect(
      criarSessaoUsuario(
        {
          usuarioRepository,
          authService,
          observability: silentObservability,
        },
        {
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          email: 'only@example.com',
          senhaSimulada: 'wrong',
        },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });

  it('throws UsuarioInputInvalidoError on invalid session input', async () => {
    const { usuarioRepository, authService } = makeUsuarioRepos();
    await expect(
      criarSessaoUsuario(
        {
          usuarioRepository,
          authService,
          observability: silentObservability,
        },
        { idPlataforma: ID_PLATAFORMA_EUNENEM, email: 'bad-email', senhaSimulada: 'x' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });
});

describe('autorizarPermissaoUsuario', () => {
  it('authorizes when session is valid and permission exists', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta,
        email: 'auth@example.com',
        nomeExibicao: 'A',
        senhaSimulada: 'p',
      },
    );

    const { token } = await criarSessaoUsuario(
      {
        usuarioRepository,
        authService,
        observability: silentObservability,
      },
      {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: 'auth@example.com',
        senhaSimulada: 'p',
      },
    );

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, authService, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).resolves.toBeUndefined();
  });

  it('throws UsuarioSessaoInvalidaError when token unknown', async () => {
    const { usuarioRepository, authService } = makeUsuarioRepos();
    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, authService, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioSessaoInvalidaError);
  });

  it('throws UsuarioSessaoInvalidaError on malformed input token', async () => {
    const { usuarioRepository, authService } = makeUsuarioRepos();
    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, authService, observability: silentObservability },
        { token: 'short', permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioSessaoInvalidaError);
  });

  it('throws UsuarioSessaoInvalidaError when usuario is missing for session', async () => {
    const { usuarioRepository, authService } = makeUsuarioRepos();
    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));
    // Seed a session whose idUsuario points at nothing in the repo.
    authService.seedSession({
      token,
      idUsuario: randomUUID(),
      expiraEm: new Date(fixedDate.getTime() + 60_000),
    });

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, authService, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioSessaoInvalidaError);
  });

  it('throws UsuarioSessaoInvalidaError when session expired', async () => {
    const { usuarioRepository, plataformaRepository, authService } = makeUsuarioRepos();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        authService,
        clock,
        observability: silentObservability,
      },
      {
        idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta,
        email: 'exp@example.com',
        nomeExibicao: 'E',
        senhaSimulada: 'p',
      },
    );

    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));
    authService.seedSession({
      token,
      idUsuario,
      expiraEm: new Date(fixedDate.getTime() - 1),
    });

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, authService, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioSessaoInvalidaError);
  });

  it('throws UsuarioNaoAutorizadoError when permission missing on account', async () => {
    const { usuarioRepository, authService } = makeUsuarioRepos();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await usuarioRepository.saveRegistroDomain({
      usuario: {
        id: idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta,
        email: 'noperm@example.com',
        nomeExibicao: 'N',
        criadoEm: fixedDate,
      },
      conta: {
        id: idConta,
        idUsuario,
        permissoes: [],
        criadaEm: fixedDate,
      },
    });

    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));
    authService.seedSession({
      token,
      idUsuario,
      expiraEm: new Date(fixedDate.getTime() + 60_000),
    });

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, authService, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioNaoAutorizadoError);
  });
});
