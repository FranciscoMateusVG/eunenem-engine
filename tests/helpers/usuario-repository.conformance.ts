import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../src/adapters/plataforma/repository.memory.js';
import type { UsuarioRepository } from '../../src/adapters/usuario/repository.js';
import { UsuarioEmailJaExisteError } from '../../src/errors/usuario/email-ja-existe.error.js';
import { UsuarioSlugJaExisteError } from '../../src/errors/usuario/slug-ja-existe.error.js';

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

    it('persists registration and resolves by id, (idPlataforma, email), and (idPlataforma, slug)', async () => {
      const idUsuario = randomUUID();
      const idConta = randomUUID();
      const usuario = {
        id: idUsuario,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idConta,
        email: 'owner@example.com',
        nomeExibicao: 'Owner',
        slug: 'owner',
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
      expect(await repo.findUsuarioBySlug(ID_PLATAFORMA_EUNENEM, 'owner')).toEqual(usuario);
      const loadedConta = await repo.findContaById(idConta);
      expect(loadedConta).toBeDefined();
      expect(loadedConta?.id).toBe(idConta);
      expect(loadedConta?.idUsuario).toBe(idUsuario);
      expect([...(loadedConta?.permissoes ?? [])]).toEqual(['campaign:admin']);
    });

    it('throws UsuarioEmailJaExisteError on duplicate (idPlataforma, email)', async () => {
      const bundle = (
        uid: string,
        aid: string,
        idPlataforma: string,
        email: string,
        slug: string,
      ) => ({
        usuario: {
          id: uid,
          idPlataforma,
          idConta: aid,
          email,
          nomeExibicao: 'A',
          slug,
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
      await repo.saveRegistroDomain(
        bundle(u1, a1, ID_PLATAFORMA_EUNENEM, 'dup@example.com', 'dup-a'),
      );

      const u2 = randomUUID();
      const a2 = randomUUID();
      await expect(
        repo.saveRegistroDomain(bundle(u2, a2, ID_PLATAFORMA_EUNENEM, 'dup@example.com', 'dup-b')),
      ).rejects.toThrow(UsuarioEmailJaExisteError);
    });

    it('throws UsuarioSlugJaExisteError on duplicate (idPlataforma, slug)', async () => {
      const u1 = randomUUID();
      const a1 = randomUUID();
      await repo.saveRegistroDomain({
        usuario: {
          id: u1,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idConta: a1,
          email: 'first@example.com',
          nomeExibicao: 'First',
          slug: 'shared-slug',
          criadoEm: fixedDate,
        },
        conta: {
          id: a1,
          idUsuario: u1,
          permissoes: ['campaign:admin'] as const,
          criadaEm: fixedDate,
        },
      });

      const u2 = randomUUID();
      const a2 = randomUUID();
      await expect(
        repo.saveRegistroDomain({
          usuario: {
            id: u2,
            idPlataforma: ID_PLATAFORMA_EUNENEM,
            idConta: a2,
            email: 'second@example.com',
            nomeExibicao: 'Second',
            slug: 'shared-slug',
            criadoEm: fixedDate,
          },
          conta: {
            id: a2,
            idUsuario: u2,
            permissoes: ['campaign:admin'] as const,
            criadaEm: fixedDate,
          },
        }),
      ).rejects.toThrow(UsuarioSlugJaExisteError);
    });

    it('allows the same slug across different plataformas', async () => {
      const slug = 'helena';
      const mk = (uid: string, aid: string, idPlataforma: string, email: string) => ({
        usuario: {
          id: uid,
          idPlataforma,
          idConta: aid,
          email,
          nomeExibicao: 'H',
          slug,
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
      await repo.saveRegistroDomain(mk(u1, a1, ID_PLATAFORMA_EUNENEM, 'h@eunenem.test'));

      const u2 = randomUUID();
      const a2 = randomUUID();
      await expect(
        repo.saveRegistroDomain(mk(u2, a2, ID_PLATAFORMA_EUCASEI, 'h@eucasei.test')),
      ).resolves.toBeUndefined();

      expect((await repo.findUsuarioBySlug(ID_PLATAFORMA_EUNENEM, slug))?.id).toBe(u1);
      expect((await repo.findUsuarioBySlug(ID_PLATAFORMA_EUCASEI, slug))?.id).toBe(u2);
    });

    it('findUsuarioBySlug returns undefined for unknown slugs', async () => {
      expect(await repo.findUsuarioBySlug(ID_PLATAFORMA_EUNENEM, 'never-existed')).toBeUndefined();
    });

    it('allows the same email across different plataformas (operator decision #2)', async () => {
      const email = 'shared@example.com';
      const bundle = (uid: string, aid: string, idPlataforma: string, slug: string) => ({
        usuario: {
          id: uid,
          idPlataforma,
          idConta: aid,
          email,
          nomeExibicao: 'Shared',
          slug,
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
      await repo.saveRegistroDomain(bundle(u1, a1, ID_PLATAFORMA_EUNENEM, 'shared-a'));

      const u2 = randomUUID();
      const a2 = randomUUID();
      await expect(
        repo.saveRegistroDomain(bundle(u2, a2, ID_PLATAFORMA_EUCASEI, 'shared-b')),
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
          slug: 'isolated',
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
          slug: 'old-name',
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

    it('removeRegistroDomain deletes Usuario + Conta + frees composite-uniqueness slots (aperture-p8i01)', async () => {
      const idUsuario = randomUUID();
      const idConta = randomUUID();
      const email = 'cleanup-target@example.com';
      const slug = 'cleanup-target';

      await repo.saveRegistroDomain({
        usuario: {
          id: idUsuario,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idConta,
          email,
          nomeExibicao: 'Clean',
          slug,
          criadoEm: fixedDate,
        },
        conta: {
          id: idConta,
          idUsuario,
          permissoes: ['campaign:admin'] as const,
          criadaEm: fixedDate,
        },
      });

      await repo.removeRegistroDomain(idUsuario);

      expect(await repo.findUsuarioById(idUsuario)).toBeUndefined();
      expect(await repo.findUsuarioByEmail(ID_PLATAFORMA_EUNENEM, email)).toBeUndefined();
      expect(await repo.findContaById(idConta)).toBeUndefined();

      // The composite-uniqueness slot is freed — re-registering with the
      // same (idPlataforma, email) and (idPlataforma, slug) succeeds.
      const idUsuario2 = randomUUID();
      const idConta2 = randomUUID();
      await expect(
        repo.saveRegistroDomain({
          usuario: {
            id: idUsuario2,
            idPlataforma: ID_PLATAFORMA_EUNENEM,
            idConta: idConta2,
            email,
            nomeExibicao: 'Clean Again',
            slug,
            criadoEm: fixedDate,
          },
          conta: {
            id: idConta2,
            idUsuario: idUsuario2,
            permissoes: ['campaign:admin'] as const,
            criadaEm: fixedDate,
          },
        }),
      ).resolves.toBeUndefined();
    });

    it('removeRegistroDomain is idempotent on unknown id (aperture-p8i01)', async () => {
      await expect(repo.removeRegistroDomain(randomUUID())).resolves.not.toThrow();
    });
  });
}
