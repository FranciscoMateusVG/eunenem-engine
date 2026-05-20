import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import { UsuarioEmailJaExisteError } from '../../../src/errors/usuario/email-ja-existe.error.js';

const fixedDate = new Date('2026-05-01T12:00:00.000Z');

describe('UsuarioRepositoryMemory', () => {
  it('persists registration and resolves by id and email', async () => {
    const repo = new UsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    const usuario = {
      id: idUsuario,
      idConta,
      email: 'owner@example.com',
      nomeExibicao: 'Owner',
      criadoEm: fixedDate,
    };
    const conta = {
      id: idConta,
      idUsuario,
      permissoes: ['campaign:admin'] as const,
      criadaEm: fixedDate,
    };
    const credencial = { idUsuario, senhaSimulada: 'stub-secret' };

    await repo.saveRegistro({ usuario, conta, credencial });

    expect(await repo.findUsuarioById(idUsuario)).toEqual(usuario);
    expect(await repo.findUsuarioByEmail('owner@example.com')).toEqual(usuario);
    expect(await repo.findContaById(idConta)).toEqual(conta);
    expect(await repo.findCredencialByIdUsuario(idUsuario)).toEqual(credencial);
  });

  it('throws UsuarioEmailJaExisteError on duplicate email', async () => {
    const repo = new UsuarioRepositoryMemory();
    const bundle = (uid: string, aid: string, email: string) => ({
      usuario: {
        id: uid,
        idConta: aid,
        email,
        nomeExibicao: 'A',
        criadoEm: fixedDate,
      },
      conta: {
        id: aid,
        idUsuario: uid,
        permissoes: ['campaign:admin'] as const,
        criadaEm: fixedDate,
      },
      credencial: { idUsuario: uid, senhaSimulada: 'p' },
    });

    const u1 = randomUUID();
    const a1 = randomUUID();
    await repo.saveRegistro(bundle(u1, a1, 'dup@example.com'));

    const u2 = randomUUID();
    const a2 = randomUUID();
    await expect(repo.saveRegistro(bundle(u2, a2, 'dup@example.com'))).rejects.toThrow(
      UsuarioEmailJaExisteError,
    );
  });

  it('updates display name', async () => {
    const repo = new UsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await repo.saveRegistro({
      usuario: {
        id: idUsuario,
        idConta,
        email: 'x@example.com',
        nomeExibicao: 'Old',
        criadoEm: fixedDate,
      },
      conta: {
        id: idConta,
        idUsuario,
        permissoes: ['campaign:admin'] as const,
        criadaEm: fixedDate,
      },
      credencial: { idUsuario, senhaSimulada: 'p' },
    });

    await repo.atualizarNomeExibicaoUsuario(idUsuario, 'New Name');
    const loaded = await repo.findUsuarioById(idUsuario);
    expect(loaded?.nomeExibicao).toBe('New Name');
  });
});
