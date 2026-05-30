import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../src/adapters/plataforma/repository.memory.js';
import type { UsuarioRepository } from '../../src/adapters/usuario/repository.js';
import { UsuarioEmailJaExisteError } from '../../src/errors/usuario/email-ja-existe.error.js';

const fixedDate = new Date('2026-05-01T12:00:00.000Z');

interface ConformanceOptions {
  readonly factory: () => UsuarioRepository | Promise<UsuarioRepository>;
  readonly resetState?: () => Promise<void>;
}

/**
 * Parameterized conformance suite for `UsuarioRepository` (aperture-xyhjr).
 *
 * Same test cases drive both `UsuarioRepositoryMemory` and
 * `UsuarioRepositoryPostgres`. Adapter parity — especially around the
 * composite (idPlataforma, email) uniqueness and the
 * `UsuarioEmailJaExisteError` shape — is enforced by running identical
 * assertions against both implementations.
 *
 * Postgres call site passes a `resetState` that truncates the tables
 * between tests; memory tests pass nothing (each test gets a fresh repo
 * via `factory`).
 */
export function describeUsuarioRepositoryConformance(name: string, options: ConformanceOptions) {
  describe(`UsuarioRepository conformance — ${name}`, () => {
    let repo: UsuarioRepository;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      repo = await options.factory();
    });

    it('persists registration and resolves by id and (idPlataforma, email)', async () => {
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

      await repo.saveRegistroDomain({ usuario, conta });

      expect(await repo.findUsuarioById(idUsuario)).toEqual(usuario);
      expect(await repo.findUsuarioByEmail(ID_PLATAFORMA_EUNENEM, 'owner@example.com')).toEqual(
        usuario,
      );
      const loadedConta = await repo.findContaById(idConta);
      expect(loadedConta).toBeDefined();
      expect(loadedConta?.id).toBe(idConta);
      expect(loadedConta?.idUsuario).toBe(idUsuario);
      expect([...(loadedConta?.permissoes ?? [])]).toEqual(['campaign:admin']);
    });

    it('throws UsuarioEmailJaExisteError on duplicate (idPlataforma, email)', async () => {
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
      });

      const u1 = randomUUID();
      const a1 = randomUUID();
      await repo.saveRegistroDomain(bundle(u1, a1, ID_PLATAFORMA_EUNENEM, 'dup@example.com'));

      const u2 = randomUUID();
      const a2 = randomUUID();
      await expect(
        repo.saveRegistroDomain(bundle(u2, a2, ID_PLATAFORMA_EUNENEM, 'dup@example.com')),
      ).rejects.toThrow(UsuarioEmailJaExisteError);
    });

    it('allows the same email across different plataformas (operator decision #2)', async () => {
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
      });

      const u1 = randomUUID();
      const a1 = randomUUID();
      await repo.saveRegistroDomain(bundle(u1, a1, ID_PLATAFORMA_EUNENEM));

      const u2 = randomUUID();
      const a2 = randomUUID();
      await expect(
        repo.saveRegistroDomain(bundle(u2, a2, ID_PLATAFORMA_EUCASEI)),
      ).resolves.toBeUndefined();

      const onEunenem = await repo.findUsuarioByEmail(ID_PLATAFORMA_EUNENEM, email);
      const onEucasei = await repo.findUsuarioByEmail(ID_PLATAFORMA_EUCASEI, email);
      expect(onEunenem?.id).toBe(u1);
      expect(onEucasei?.id).toBe(u2);
    });

    it('findUsuarioByEmail returns undefined when email exists on another plataforma only', async () => {
      const idUsuario = randomUUID();
      const idConta = randomUUID();
      await repo.saveRegistroDomain({
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
      });

      expect(
        await repo.findUsuarioByEmail(ID_PLATAFORMA_EUCASEI, 'isolated@example.com'),
      ).toBeUndefined();
    });

    it('updates display name', async () => {
      const idUsuario = randomUUID();
      const idConta = randomUUID();
      await repo.saveRegistroDomain({
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
      });

      await repo.atualizarNomeExibicaoUsuario(idUsuario, 'New Name');
      const loaded = await repo.findUsuarioById(idUsuario);
      expect(loaded?.nomeExibicao).toBe('New Name');
    });
  });
}
