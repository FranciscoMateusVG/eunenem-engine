import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import { SessaoUsuarioRepositoryMemory } from '../../../src/adapters/usuario/sessao-repository.memory.js';
import { TokenSessaoSchema } from '../../../src/domain/usuario/value-objects/token-sessao.js';
import { UsuarioEmailJaExisteError } from '../../../src/errors/usuario/email-ja-existe.error.js';
import { UsuarioInputInvalidoError } from '../../../src/errors/usuario/input-invalido.error.js';
import { UsuarioNaoAutorizadoError } from '../../../src/errors/usuario/nao-autorizado.error.js';
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

describe('registrarContaUsuario', () => {
  it('registers user, account and simulated credential', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();

    const result = await registrarContaUsuario(
      { usuarioRepository, clock, observability: silentObservability },
      {
        idUsuario,
        idConta,
        email: 'creator@example.com',
        nomeExibicao: 'Campaign Owner',
        senhaSimulada: 'not-a-real-password',
      },
    );

    expect(result.usuario.id).toBe(idUsuario);
    expect(result.conta.id).toBe(idConta);
    expect(result.conta.permissoes).toEqual(['campaign:admin']);
    expect(await usuarioRepository.findUsuarioByEmail('creator@example.com')).toEqual(
      result.usuario,
    );
  });

  it('throws UsuarioInputInvalidoError on invalid email', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    await expect(
      registrarContaUsuario(
        { usuarioRepository, clock, observability: silentObservability },
        {
          idUsuario: randomUUID(),
          idConta: randomUUID(),
          email: 'not-an-email',
          nomeExibicao: 'X',
          senhaSimulada: 'p',
        },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });

  it('throws UsuarioEmailJaExisteError when email is taken', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const email = 'taken@example.com';
    await registrarContaUsuario(
      { usuarioRepository, clock, observability: silentObservability },
      {
        idUsuario: randomUUID(),
        idConta: randomUUID(),
        email,
        nomeExibicao: 'One',
        senhaSimulada: 'p',
      },
    );

    await expect(
      registrarContaUsuario(
        { usuarioRepository, clock, observability: silentObservability },
        {
          idUsuario: randomUUID(),
          idConta: randomUUID(),
          email,
          nomeExibicao: 'Two',
          senhaSimulada: 'p',
        },
      ),
    ).rejects.toThrow(UsuarioEmailJaExisteError);
  });
});

describe('atualizarPerfilUsuario', () => {
  it('updates display name', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await registrarContaUsuario(
      { usuarioRepository, clock, observability: silentObservability },
      {
        idUsuario,
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
    const usuarioRepository = new UsuarioRepositoryMemory();
    await expect(
      atualizarPerfilUsuario(
        { usuarioRepository, observability: silentObservability },
        { idUsuario: randomUUID(), nomeExibicao: 'Ghost' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });

  it('throws UsuarioInputInvalidoError on invalid profile input', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    await expect(
      atualizarPerfilUsuario(
        { usuarioRepository, observability: silentObservability },
        { idUsuario: randomUUID(), nomeExibicao: '' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });
});

describe('criarSessaoUsuario', () => {
  it('creates a session when simulated password matches', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const email = 'login@example.com';
    const password = 'secret-stub';
    await registrarContaUsuario(
      { usuarioRepository, clock, observability: silentObservability },
      {
        idUsuario: randomUUID(),
        idConta: randomUUID(),
        email,
        nomeExibicao: 'L',
        senhaSimulada: password,
      },
    );

    const sessao = await criarSessaoUsuario(
      {
        usuarioRepository,
        sessaoRepository,
        clock,
        sessionTtlMs: 60_000,
        observability: silentObservability,
      },
      { email, senhaSimulada: password },
    );

    expect(sessao.token.length).toBeGreaterThanOrEqual(32);
    expect(sessao.expiraEm.getTime()).toBe(fixedDate.getTime() + 60_000);
  });

  it('throws on bad credentials', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    await registrarContaUsuario(
      { usuarioRepository, clock, observability: silentObservability },
      {
        idUsuario: randomUUID(),
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
          sessaoRepository,
          clock,
          sessionTtlMs: 60_000,
          observability: silentObservability,
        },
        { email: 'only@example.com', senhaSimulada: 'wrong' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });

  it('throws UsuarioInputInvalidoError on invalid session input', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    await expect(
      criarSessaoUsuario(
        {
          usuarioRepository,
          sessaoRepository,
          clock,
          sessionTtlMs: 60_000,
          observability: silentObservability,
        },
        { email: 'bad-email', senhaSimulada: 'x' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });
});

describe('autorizarPermissaoUsuario', () => {
  it('authorizes when session is valid and permission exists', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await registrarContaUsuario(
      { usuarioRepository, clock, observability: silentObservability },
      {
        idUsuario,
        idConta,
        email: 'auth@example.com',
        nomeExibicao: 'A',
        senhaSimulada: 'p',
      },
    );

    const { token } = await criarSessaoUsuario(
      {
        usuarioRepository,
        sessaoRepository,
        clock,
        sessionTtlMs: 60_000,
        observability: silentObservability,
      },
      { email: 'auth@example.com', senhaSimulada: 'p' },
    );

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, sessaoRepository, clock, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).resolves.toBeUndefined();
  });

  it('throws UsuarioSessaoInvalidaError when token unknown', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, sessaoRepository, clock, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioSessaoInvalidaError);
  });

  it('throws UsuarioSessaoInvalidaError on malformed input token', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, sessaoRepository, clock, observability: silentObservability },
        { token: 'short', permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioSessaoInvalidaError);
  });

  it('throws UsuarioSessaoInvalidaError when account is missing for session', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));
    await sessaoRepository.save({
      token,
      idConta: randomUUID(),
      expiraEm: new Date(fixedDate.getTime() + 60_000),
    });

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, sessaoRepository, clock, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioSessaoInvalidaError);
  });

  it('throws UsuarioSessaoInvalidaError when session expired', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await registrarContaUsuario(
      { usuarioRepository, clock, observability: silentObservability },
      {
        idUsuario,
        idConta,
        email: 'exp@example.com',
        nomeExibicao: 'E',
        senhaSimulada: 'p',
      },
    );

    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));
    await sessaoRepository.save({
      token,
      idConta,
      expiraEm: new Date(fixedDate.getTime() - 1),
    });

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, sessaoRepository, clock, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioSessaoInvalidaError);
  });

  it('throws UsuarioNaoAutorizadoError when permission missing on account', async () => {
    const usuarioRepository = new UsuarioRepositoryMemory();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await usuarioRepository.saveRegistro({
      usuario: {
        id: idUsuario,
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
      credencial: { idUsuario, senhaSimulada: 'p' },
    });

    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));
    await sessaoRepository.save({
      token,
      idConta,
      expiraEm: new Date(fixedDate.getTime() + 60_000),
    });

    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, sessaoRepository, clock, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioNaoAutorizadoError);
  });
});
