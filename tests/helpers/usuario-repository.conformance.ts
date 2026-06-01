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

    // ───── findUsuariosByEmailPrefix (aperture-5d3yz) ─────

    const seedForPrefixTests = async (
      idPlataforma: string,
      rows: Array<{ email: string; slug: string }>,
    ) => {
      for (const { email, slug } of rows) {
        const idUsuario = randomUUID();
        const idConta = randomUUID();
        await repo.saveRegistroDomain({
          usuario: {
            id: idUsuario,
            idPlataforma,
            idConta,
            email,
            nomeExibicao: email.split('@')[0] ?? email,
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
      }
    };

    it('findUsuariosByEmailPrefix — case-insensitive prefix match (aperture-5d3yz)', async () => {
      await seedForPrefixTests(ID_PLATAFORMA_EUNENEM, [
        { email: 'Mariana@example.com', slug: 'mariana' },
        { email: 'MARIA@example.com', slug: 'maria' },
        { email: 'marina@example.com', slug: 'marina' },
        { email: 'bob@example.com', slug: 'bob' },
      ]);

      const results = await repo.findUsuariosByEmailPrefix(ID_PLATAFORMA_EUNENEM, 'mari', 20);
      const emails = results.map((u) => u.email);
      expect(emails).toContain('Mariana@example.com');
      expect(emails).toContain('MARIA@example.com');
      expect(emails).toContain('marina@example.com');
      expect(emails).not.toContain('bob@example.com');
    });

    it('findUsuariosByEmailPrefix — tenant isolation (aperture-5d3yz)', async () => {
      await seedForPrefixTests(ID_PLATAFORMA_EUNENEM, [
        { email: 'shared-eunenem@example.com', slug: 'shared-eu' },
      ]);
      await seedForPrefixTests(ID_PLATAFORMA_EUCASEI, [
        { email: 'shared-eucasei@example.com', slug: 'shared-ec' },
      ]);

      const fromEunenem = await repo.findUsuariosByEmailPrefix(ID_PLATAFORMA_EUNENEM, 'shared', 20);
      expect(fromEunenem.map((u) => u.email)).toEqual(['shared-eunenem@example.com']);

      const fromEucasei = await repo.findUsuariosByEmailPrefix(ID_PLATAFORMA_EUCASEI, 'shared', 20);
      expect(fromEucasei.map((u) => u.email)).toEqual(['shared-eucasei@example.com']);
    });

    it('findUsuariosByEmailPrefix — honours the limit (aperture-5d3yz)', async () => {
      await seedForPrefixTests(ID_PLATAFORMA_EUNENEM, [
        { email: 'a1@x.com', slug: 'a1' },
        { email: 'a2@x.com', slug: 'a2' },
        { email: 'a3@x.com', slug: 'a3' },
        { email: 'a4@x.com', slug: 'a4' },
        { email: 'a5@x.com', slug: 'a5' },
      ]);

      const results = await repo.findUsuariosByEmailPrefix(ID_PLATAFORMA_EUNENEM, 'a', 3);
      expect(results).toHaveLength(3);
    });

    it('findUsuariosByEmailPrefix — empty prefix returns empty (aperture-5d3yz)', async () => {
      await seedForPrefixTests(ID_PLATAFORMA_EUNENEM, [
        { email: 'someone@example.com', slug: 'someone' },
      ]);
      const results = await repo.findUsuariosByEmailPrefix(ID_PLATAFORMA_EUNENEM, '', 20);
      expect(results).toEqual([]);
    });

    it('findUsuariosByEmailPrefix — no matches returns empty (aperture-5d3yz)', async () => {
      await seedForPrefixTests(ID_PLATAFORMA_EUNENEM, [
        { email: 'someone@example.com', slug: 'someone' },
      ]);
      const results = await repo.findUsuariosByEmailPrefix(ID_PLATAFORMA_EUNENEM, 'zzz', 20);
      expect(results).toEqual([]);
    });

    it('findUsuariosByEmailPrefix — ordered by email ascending (aperture-5d3yz)', async () => {
      await seedForPrefixTests(ID_PLATAFORMA_EUNENEM, [
        { email: 'mary@x.com', slug: 'mary' },
        { email: 'maggie@x.com', slug: 'maggie' },
        { email: 'matt@x.com', slug: 'matt' },
      ]);

      const results = await repo.findUsuariosByEmailPrefix(ID_PLATAFORMA_EUNENEM, 'ma', 20);
      const emails = results.map((u) => u.email);
      expect(emails).toEqual([...emails].sort());
    });

    it('findUsuariosByEmailPrefix — LIKE metacharacters in input are escaped (aperture-5d3yz)', async () => {
      await seedForPrefixTests(ID_PLATAFORMA_EUNENEM, [
        { email: 'literal_underscore@x.com', slug: 'lit-under' },
        { email: 'liberal@x.com', slug: 'liberal' },
      ]);

      // `_` is a LIKE wildcard (single char). With escaping it must be a
      // literal — so `lit_e` should match `literal_underscore` (because
      // its email begins with `literal_` and that string starts with
      // `lit_e`... wait — `literal_underscore` starts with `literal` not
      // `lit_e`. Let me re-design: we want to PROVE escape happens.
      // Search for `liter_l` which would unescaped match `liberal` (since
      // `_` is wildcard) AND `literal_underscore`. Escaped, only
      // `literal_*` should match (since `_` is literal).
      const results = await repo.findUsuariosByEmailPrefix(ID_PLATAFORMA_EUNENEM, 'liter_l', 20);
      const emails = results.map((u) => u.email);
      expect(emails).not.toContain('liberal@x.com'); // would match if `_` weren't escaped
      // No match for literal `liter_l` either — emails don't contain that substring at start.
      expect(emails).toEqual([]);
    });
  });
}
