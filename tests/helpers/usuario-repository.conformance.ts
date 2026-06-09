import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../src/adapters/plataforma/repository.memory.js';
import type { UsuarioRepository } from '../../src/adapters/usuario/repository.js';
import {
  decodeUsuariosPaginadosCursor,
  encodeUsuariosPaginadosCursor,
} from '../../src/adapters/usuario/repository.js';
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

    // ───── findUsuarioByConta (aperture-lp9cw) ────────────────────────

    it('findUsuarioByConta returns the Usuario when idConta + idPlataforma match (aperture-lp9cw)', async () => {
      const idUsuario = randomUUID();
      const idConta = randomUUID();
      await repo.saveRegistroDomain({
        usuario: {
          id: idUsuario,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idConta,
          email: 'lookup@example.com',
          nomeExibicao: 'Lookup',
          slug: 'lookup',
          criadoEm: fixedDate,
        },
        conta: {
          id: idConta,
          idUsuario,
          permissoes: ['campaign:admin'] as const,
          criadaEm: fixedDate,
        },
      });

      const found = await repo.findUsuarioByConta(idConta, ID_PLATAFORMA_EUNENEM);
      expect(found?.id).toBe(idUsuario);
      expect(found?.email).toBe('lookup@example.com');
      expect(found?.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    });

    it('findUsuarioByConta returns undefined when idConta does not exist (aperture-lp9cw)', async () => {
      expect(await repo.findUsuarioByConta(randomUUID(), ID_PLATAFORMA_EUNENEM)).toBeUndefined();
    });

    it('findUsuarioByConta returns undefined when the resolved Usuario is on a different plataforma (aperture-lp9cw)', async () => {
      // Seed a Usuario on EUNENEM, then query with EUCASEI — tenant
      // isolation MUST prevent cross-tenant leak.
      const idUsuario = randomUUID();
      const idConta = randomUUID();
      await repo.saveRegistroDomain({
        usuario: {
          id: idUsuario,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idConta,
          email: 'cross-tenant-target@example.com',
          nomeExibicao: 'Target',
          slug: 'cross-tenant-target',
          criadoEm: fixedDate,
        },
        conta: {
          id: idConta,
          idUsuario,
          permissoes: ['campaign:admin'] as const,
          criadaEm: fixedDate,
        },
      });

      // Right plataforma — resolves.
      const right = await repo.findUsuarioByConta(idConta, ID_PLATAFORMA_EUNENEM);
      expect(right?.id).toBe(idUsuario);

      // Wrong plataforma — undefined, NOT the EUNENEM user.
      const wrong = await repo.findUsuarioByConta(idConta, ID_PLATAFORMA_EUCASEI);
      expect(wrong).toBeUndefined();
    });

    it('findUsuarioByConta does not leak between same-slug-different-plataforma usuarios (aperture-lp9cw)', async () => {
      // Two distinct usuarios with the SAME slug on different plataformas
      // (allowed per operator decision #2). The idConta-keyed lookup must
      // route to the correct one per tenant filter.
      const u1 = randomUUID();
      const a1 = randomUUID();
      const u2 = randomUUID();
      const a2 = randomUUID();
      await repo.saveRegistroDomain({
        usuario: {
          id: u1,
          idPlataforma: ID_PLATAFORMA_EUNENEM,
          idConta: a1,
          email: 'a@eunenem.test',
          nomeExibicao: 'A',
          slug: 'twin-slug',
          criadoEm: fixedDate,
        },
        conta: {
          id: a1,
          idUsuario: u1,
          permissoes: ['campaign:admin'] as const,
          criadaEm: fixedDate,
        },
      });
      await repo.saveRegistroDomain({
        usuario: {
          id: u2,
          idPlataforma: ID_PLATAFORMA_EUCASEI,
          idConta: a2,
          email: 'b@eucasei.test',
          nomeExibicao: 'B',
          slug: 'twin-slug',
          criadoEm: fixedDate,
        },
        conta: {
          id: a2,
          idUsuario: u2,
          permissoes: ['campaign:admin'] as const,
          criadaEm: fixedDate,
        },
      });

      expect((await repo.findUsuarioByConta(a1, ID_PLATAFORMA_EUNENEM))?.id).toBe(u1);
      expect((await repo.findUsuarioByConta(a2, ID_PLATAFORMA_EUCASEI))?.id).toBe(u2);
      // Cross-routing must NOT happen.
      expect(await repo.findUsuarioByConta(a1, ID_PLATAFORMA_EUCASEI)).toBeUndefined();
      expect(await repo.findUsuarioByConta(a2, ID_PLATAFORMA_EUNENEM)).toBeUndefined();
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

    // ───── findUsuariosPaginated (aperture-qatwz) ─────

    /**
     * Seed N usuarios with predictable email + nome_exibicao + criado_em
     * values for paginated browse tests. `n` rows numbered 01..N (or 001..N
     * for n>=100) so emails sort lexicographically the same way as the
     * numeric index. `criadoEm` increases by 1 second per row so it's also
     * monotone with the index.
     */
    const seedForPaginatedTests = async (
      idPlataforma: string,
      n: number,
      opts?: { readonly emailPrefix?: string; readonly basePadding?: number },
    ): Promise<readonly { id: string; email: string; nomeExibicao: string; criadoEm: Date }[]> => {
      const prefix = opts?.emailPrefix ?? 'user';
      const pad = opts?.basePadding ?? Math.max(2, String(n).length);
      const out: { id: string; email: string; nomeExibicao: string; criadoEm: Date }[] = [];
      for (let i = 1; i <= n; i++) {
        const idx = String(i).padStart(pad, '0');
        const id = randomUUID();
        const idConta = randomUUID();
        const email = `${prefix}${idx}@example.com`;
        const nomeExibicao = `Nome ${idx}`;
        const criadoEm = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
        await repo.saveRegistroDomain({
          usuario: {
            id,
            idPlataforma,
            idConta,
            email,
            nomeExibicao,
            slug: `${prefix}-${idx}-${id.slice(0, 8)}`,
            criadoEm,
          },
          conta: {
            id: idConta,
            idUsuario: id,
            permissoes: ['campaign:admin'] as const,
            criadaEm: criadoEm,
          },
        });
        out.push({ id, email, nomeExibicao, criadoEm });
      }
      return out;
    };

    it('findUsuariosPaginated — page boundaries: last row of page N == cursor source for page N+1 (aperture-qatwz)', async () => {
      const rows = await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 7);

      const page1 = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 3,
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(page1.usuarios.map((u) => u.email)).toEqual(rows.slice(0, 3).map((r) => r.email));
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.totalCount).toBe(7);

      const page2 = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: page1.nextCursor,
        limit: 3,
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(page2.usuarios.map((u) => u.email)).toEqual(rows.slice(3, 6).map((r) => r.email));
      expect(page2.nextCursor).not.toBeNull();

      const page3 = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: page2.nextCursor,
        limit: 3,
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(page3.usuarios.map((u) => u.email)).toEqual([rows[6]?.email]);
      expect(page3.nextCursor).toBeNull();
    });

    it('findUsuariosPaginated — tie-break on idUsuario when sort column has duplicates (aperture-qatwz)', async () => {
      // Force a tie on nomeExibicao: all 5 rows share the same name.
      const sharedName = 'Mesmo Nome';
      const sharedDate = new Date('2026-03-01T00:00:00.000Z');
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const id = randomUUID();
        const idConta = randomUUID();
        await repo.saveRegistroDomain({
          usuario: {
            id,
            idPlataforma: ID_PLATAFORMA_EUNENEM,
            idConta,
            email: `tied-${i}@example.com`,
            nomeExibicao: sharedName,
            slug: `tied-${i}-${id.slice(0, 8)}`,
            criadoEm: sharedDate,
          },
          conta: {
            id: idConta,
            idUsuario: id,
            permissoes: ['campaign:admin'] as const,
            criadaEm: sharedDate,
          },
        });
        ids.push(id);
      }
      const sortedIds = [...ids].sort();

      // Traverse all pages, asserting strict id-ascending order (the
      // tie-break) and no duplicates / skips.
      const visited: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
          cursor,
          limit: 2,
          sortBy: 'nomeExibicao',
          sortDir: 'asc',
        });
        visited.push(...page.usuarios.map((u) => u.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(visited).toEqual(sortedIds);
    });

    it('findUsuariosPaginated — emailPrefix filter narrows the set; cursor still walks the narrowed set (aperture-qatwz)', async () => {
      // 4 'mari*' + 3 'bob*' rows
      const mariRows = await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 4, {
        emailPrefix: 'mari',
      });
      await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 3, { emailPrefix: 'bob' });

      const page1 = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 2,
        sortBy: 'email',
        sortDir: 'asc',
        emailPrefix: 'mari',
      });
      expect(page1.totalCount).toBe(4);
      expect(page1.usuarios.map((u) => u.email)).toEqual([mariRows[0]?.email, mariRows[1]?.email]);

      const page2 = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: page1.nextCursor,
        limit: 2,
        sortBy: 'email',
        sortDir: 'asc',
        emailPrefix: 'mari',
      });
      expect(page2.usuarios.map((u) => u.email)).toEqual([mariRows[2]?.email, mariRows[3]?.email]);
      expect(page2.nextCursor).toBeNull();
    });

    it('findUsuariosPaginated — empty/undefined emailPrefix returns full tenant (different from findUsuariosByEmailPrefix) (aperture-qatwz)', async () => {
      await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 3);

      const withUndefined = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 50,
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(withUndefined.totalCount).toBe(3);
      expect(withUndefined.usuarios.length).toBe(3);

      const withEmpty = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 50,
        sortBy: 'email',
        sortDir: 'asc',
        emailPrefix: '',
      });
      expect(withEmpty.totalCount).toBe(3);
      expect(withEmpty.usuarios.length).toBe(3);
    });

    it('findUsuariosPaginated — filter matches nothing: empty array, null cursor, totalCount 0 (aperture-qatwz)', async () => {
      await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 3);
      const result = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 50,
        sortBy: 'email',
        sortDir: 'asc',
        emailPrefix: 'zzz-nothing-here',
      });
      expect(result.usuarios).toEqual([]);
      expect(result.nextCursor).toBeNull();
      expect(result.totalCount).toBe(0);
    });

    it('findUsuariosPaginated — cursor opacity: round-trip preserves; invalid cursor throws (aperture-qatwz)', async () => {
      await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 4);
      const page1 = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 2,
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(page1.nextCursor).toBeTypeOf('string');
      // base64url should not contain `+`, `/`, or `=` padding.
      expect(page1.nextCursor).not.toMatch(/[+/=]/);
      // Round-trip through decode should yield a string sortValue + uuid.
      const decoded = decodeUsuariosPaginadosCursor(page1.nextCursor as string);
      expect(typeof decoded.sortValue).toBe('string');
      expect(decoded.idUsuario).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // Garbage cursor → throws "Invalid pagination cursor: ..."
      await expect(
        repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
          cursor: '!!!not-base64url!!!',
          limit: 2,
          sortBy: 'email',
          sortDir: 'asc',
        }),
      ).rejects.toThrow(/Invalid pagination cursor/);
    });

    it('findUsuariosPaginated — limit clamping: >100 → 100, <1 → 1, non-integer floored (aperture-qatwz)', async () => {
      await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 5);

      const overflow = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 500, // clamp to 100; only 5 rows exist so we get all 5
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(overflow.usuarios.length).toBe(5);
      expect(overflow.nextCursor).toBeNull();

      const underflow = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 0, // clamp to 1
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(underflow.usuarios.length).toBe(1);
      expect(underflow.nextCursor).not.toBeNull();

      const negative = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: -10, // clamp to 1
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(negative.usuarios.length).toBe(1);

      const fractional = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 2.9, // floor → 2
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(fractional.usuarios.length).toBe(2);
    });

    it('findUsuariosPaginated — LIKE metacharacters in emailPrefix are escaped (aperture-qatwz)', async () => {
      // Same proof-of-escape pattern as findUsuariosByEmailPrefix test:
      // unescaped `_` would let "liter_l" match "liberal" (`_` = single
      // wildcard char). Escaped, it's a literal and matches nothing here.
      await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 0); // seed nothing first

      // Manual two-row seed with metachar-bait emails.
      const seedOne = async (email: string, slug: string) => {
        const id = randomUUID();
        const idConta = randomUUID();
        await repo.saveRegistroDomain({
          usuario: {
            id,
            idPlataforma: ID_PLATAFORMA_EUNENEM,
            idConta,
            email,
            nomeExibicao: email,
            slug,
            criadoEm: fixedDate,
          },
          conta: {
            id: idConta,
            idUsuario: id,
            permissoes: ['campaign:admin'] as const,
            criadaEm: fixedDate,
          },
        });
      };
      await seedOne('literal_underscore@x.com', 'lit-under-qatwz');
      await seedOne('liberal@x.com', 'liberal-qatwz');

      const result = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 50,
        sortBy: 'email',
        sortDir: 'asc',
        emailPrefix: 'liter_l',
      });
      expect(result.usuarios.map((u) => u.email)).not.toContain('liberal@x.com');
      expect(result.usuarios).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it('findUsuariosPaginated — multi-page traversal visits each row exactly once across all sort modes (aperture-qatwz)', async () => {
      const rows = await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 11);
      const expectedIds = new Set(rows.map((r) => r.id));

      for (const sortBy of ['criadoEm', 'email', 'nomeExibicao'] as const) {
        for (const sortDir of ['asc', 'desc'] as const) {
          const visited: string[] = [];
          let cursor: string | null = null;
          let guard = 0;
          while (guard++ < 20) {
            const page = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
              cursor,
              limit: 4,
              sortBy,
              sortDir,
            });
            visited.push(...page.usuarios.map((u) => u.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
          }
          expect(new Set(visited)).toEqual(expectedIds);
          expect(visited.length).toBe(11); // no duplicates
        }
      }
    });

    it('findUsuariosPaginated — tenant isolation: other-plataforma rows never leak (aperture-qatwz)', async () => {
      await seedForPaginatedTests(ID_PLATAFORMA_EUNENEM, 3, { emailPrefix: 'eu' });
      await seedForPaginatedTests(ID_PLATAFORMA_EUCASEI, 5, { emailPrefix: 'ec' });

      const eunenemPage = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUNENEM, {
        cursor: null,
        limit: 50,
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(eunenemPage.totalCount).toBe(3);
      expect(eunenemPage.usuarios.every((u) => u.idPlataforma === ID_PLATAFORMA_EUNENEM)).toBe(
        true,
      );

      const eucaseiPage = await repo.findUsuariosPaginated(ID_PLATAFORMA_EUCASEI, {
        cursor: null,
        limit: 50,
        sortBy: 'email',
        sortDir: 'asc',
      });
      expect(eucaseiPage.totalCount).toBe(5);
      expect(eucaseiPage.usuarios.every((u) => u.idPlataforma === ID_PLATAFORMA_EUCASEI)).toBe(
        true,
      );
    });

    it('findUsuariosPaginated — cursor encode round-trip is canonical across adapters (aperture-qatwz)', async () => {
      // The cursor helpers are SHARED between memory + postgres adapters
      // — assert that the encoder/decoder pair is a pure round-trip so
      // cursors emitted by one adapter would decode the same way (relevant
      // if we ever swap adapters mid-session or build a test harness that
      // composes both).
      const payload = {
        sortValue: '2026-05-12T15:30:45.123Z',
        idUsuario: '11111111-2222-3333-4444-555555555555',
      };
      const encoded = encodeUsuariosPaginadosCursor(payload);
      expect(encoded).not.toMatch(/[+/=]/);
      const decoded = decodeUsuariosPaginadosCursor(encoded);
      expect(decoded).toEqual(payload);
    });
  });
}
