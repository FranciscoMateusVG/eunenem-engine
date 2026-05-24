import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import { SessaoUsuarioRepositoryMemory } from '../../../src/adapters/usuario/sessao-repository.memory.js';
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

function makeUsuarioRepos() {
  return {
    usuarioRepository: new UsuarioRepositoryMemory(),
    plataformaRepository: new PlataformaRepositoryMemory(),
  };
}

describe('registrarContaUsuario', () => {
  it('registers user, account and simulated credential scoped to plataforma', async () => {
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    const idUsuario = randomUUID();
    const idConta = randomUUID();

    const result = await registrarContaUsuario(
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    await expect(
      registrarContaUsuario(
        { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    await expect(
      registrarContaUsuario(
        { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    const email = 'taken@example.com';
    await registrarContaUsuario(
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
        { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    const email = 'multi@example.com';

    const eunenem = await registrarContaUsuario(
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
});

describe('atualizarPerfilUsuario', () => {
  it('updates display name', async () => {
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await registrarContaUsuario(
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const email = 'login@example.com';
    const password = 'secret-stub';
    await registrarContaUsuario(
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
        sessaoRepository,
        clock,
        sessionTtlMs: 60_000,
        observability: silentObservability,
      },
      { idPlataforma: ID_PLATAFORMA_EUNENEM, email, senhaSimulada: password },
    );

    expect(sessao.token.length).toBeGreaterThanOrEqual(32);
    expect(sessao.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(sessao.expiraEm.getTime()).toBe(fixedDate.getTime() + 60_000);
  });

  it('refuses to log in against a plataforma where the email is not registered', async () => {
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const email = 'only-eunenem@example.com';
    await registrarContaUsuario(
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
          sessaoRepository,
          clock,
          sessionTtlMs: 60_000,
          observability: silentObservability,
        },
        { idPlataforma: ID_PLATAFORMA_EUCASEI, email, senhaSimulada: 'right' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });

  it('throws on bad credentials', async () => {
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    await registrarContaUsuario(
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
          sessaoRepository,
          clock,
          sessionTtlMs: 60_000,
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
    const { usuarioRepository } = makeUsuarioRepos();
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
        { idPlataforma: ID_PLATAFORMA_EUNENEM, email: 'bad-email', senhaSimulada: 'x' },
      ),
    ).rejects.toThrow(UsuarioInputInvalidoError);
  });
});

describe('autorizarPermissaoUsuario', () => {
  it('authorizes when session is valid and permission exists', async () => {
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await registrarContaUsuario(
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
        sessaoRepository,
        clock,
        sessionTtlMs: 60_000,
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
        { usuarioRepository, sessaoRepository, clock, observability: silentObservability },
        { token, permissao: 'campaign:admin' },
      ),
    ).resolves.toBeUndefined();
  });

  it('throws UsuarioSessaoInvalidaError when token unknown', async () => {
    const { usuarioRepository } = makeUsuarioRepos();
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
    const { usuarioRepository } = makeUsuarioRepos();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    await expect(
      autorizarPermissaoUsuario(
        { usuarioRepository, sessaoRepository, clock, observability: silentObservability },
        { token: 'short', permissao: 'campaign:admin' },
      ),
    ).rejects.toThrow(UsuarioSessaoInvalidaError);
  });

  it('throws UsuarioSessaoInvalidaError when account is missing for session', async () => {
    const { usuarioRepository } = makeUsuarioRepos();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));
    await sessaoRepository.save({
      token,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
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
    const { usuarioRepository, plataformaRepository } = makeUsuarioRepos();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await registrarContaUsuario(
      { usuarioRepository, plataformaRepository, clock, observability: silentObservability },
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
    await sessaoRepository.save({
      token,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
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
    const { usuarioRepository } = makeUsuarioRepos();
    const sessaoRepository = new SessaoUsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await usuarioRepository.saveRegistro({
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
      credencial: { idUsuario, senhaSimulada: 'p' },
    });

    const token = TokenSessaoSchema.parse(randomBytes(32).toString('base64url'));
    await sessaoRepository.save({
      token,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
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
