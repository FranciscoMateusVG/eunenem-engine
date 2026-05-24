import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import { UsuarioEmailJaExisteError } from '../../../src/errors/usuario/email-ja-existe.error.js';

const fixedDate = new Date('2026-05-01T12:00:00.000Z');

describe('UsuarioRepositoryMemory', () => {
  it('persists registration and resolves by id and (idPlataforma, email)', async () => {
    const repo = new UsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    const usuario = {
      id: idUsuario,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
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
    expect(await repo.findUsuarioByEmail(ID_PLATAFORMA_EUNENEM, 'owner@example.com')).toEqual(
      usuario,
    );
    expect(await repo.findContaById(idConta)).toEqual(conta);
    expect(await repo.findCredencialByIdUsuario(idUsuario)).toEqual(credencial);
  });

  it('throws UsuarioEmailJaExisteError on duplicate (idPlataforma, email)', async () => {
    const repo = new UsuarioRepositoryMemory();
    const bundle = (uid: string, aid: string, idPlataforma: string, email: string) => ({
      usuario: {
        id: uid,
        idPlataforma,
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
    await repo.saveRegistro(bundle(u1, a1, ID_PLATAFORMA_EUNENEM, 'dup@example.com'));

    const u2 = randomUUID();
    const a2 = randomUUID();
    await expect(
      repo.saveRegistro(bundle(u2, a2, ID_PLATAFORMA_EUNENEM, 'dup@example.com')),
    ).rejects.toThrow(UsuarioEmailJaExisteError);
  });

  it('allows the same email across different plataformas', async () => {
    const repo = new UsuarioRepositoryMemory();
    const email = 'shared@example.com';
    const bundle = (uid: string, aid: string, idPlataforma: string) => ({
      usuario: {
        id: uid,
        idPlataforma,
        idConta: aid,
        email,
        nomeExibicao: 'Shared',
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
    await repo.saveRegistro(bundle(u1, a1, ID_PLATAFORMA_EUNENEM));

    const u2 = randomUUID();
    const a2 = randomUUID();
    await expect(repo.saveRegistro(bundle(u2, a2, ID_PLATAFORMA_EUCASEI))).resolves.toBeUndefined();

    const onEunenem = await repo.findUsuarioByEmail(ID_PLATAFORMA_EUNENEM, email);
    const onEucasei = await repo.findUsuarioByEmail(ID_PLATAFORMA_EUCASEI, email);
    expect(onEunenem?.id).toBe(u1);
    expect(onEucasei?.id).toBe(u2);
  });

  it('findUsuarioByEmail returns undefined when email exists on another plataforma only', async () => {
    const repo = new UsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await repo.saveRegistro({
      usuario: {
        id: idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta,
        email: 'isolated@example.com',
        nomeExibicao: 'I',
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

    expect(
      await repo.findUsuarioByEmail(ID_PLATAFORMA_EUCASEI, 'isolated@example.com'),
    ).toBeUndefined();
  });

  it('updates display name', async () => {
    const repo = new UsuarioRepositoryMemory();
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    await repo.saveRegistro({
      usuario: {
        id: idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
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
