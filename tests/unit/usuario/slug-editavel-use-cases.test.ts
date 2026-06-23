import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import type { Conta, Usuario } from '../../../src/domain/usuario/entities/usuario.js';
import type {
  IdContaUsuario,
  IdPlataformaReferencia,
  IdUsuario,
} from '../../../src/domain/usuario/value-objects/ids.js';
import { UsuarioInputInvalidoError } from '../../../src/errors/usuario/input-invalido.error.js';
import { UsuarioNaoEncontradoError } from '../../../src/errors/usuario/nao-encontrado.error.js';
import { UsuarioSlugJaExisteError } from '../../../src/errors/usuario/slug-ja-existe.error.js';
import { atualizarSlugUsuario } from '../../../src/use-cases/usuario/atualizar-slug-usuario.js';
import { verificarDisponibilidadeSlug } from '../../../src/use-cases/usuario/verificar-disponibilidade-slug.js';
import { createTestObservability } from '../../helpers/observability.js';

/**
 * Use-case-level tests for the editable-slug path (aperture-2ztes).
 *
 * Adapter-level conformance (success round-trip, collision →
 * UsuarioSlugJaExisteError in BOTH adapters) lives in
 * tests/helpers/usuario-repository.conformance.ts. Here we verify the
 * use-case wrappers:
 *   - atualizarSlugUsuario: invalid format → UsuarioInputInvalidoError
 *     (NOT a 500); missing user → UsuarioNaoEncontradoError (typed 404);
 *     taken slug → UsuarioSlugJaExisteError propagates (no auto-suffix);
 *     happy path returns the updated Usuario.
 *   - verificarDisponibilidadeSlug: format/em_uso are RESULTS not errors;
 *     re-checking your own current slug is available; missing caller 404s.
 */

const ID_PLATAFORMA = randomUUID() as IdPlataformaReferencia;
const ID_PLATAFORMA_OUTRA = randomUUID() as IdPlataformaReferencia;
const fixedDate = new Date('2026-06-09T12:00:00Z');

async function seedUsuario(
  repo: UsuarioRepositoryMemory,
  overrides: Partial<Usuario> = {},
): Promise<Usuario> {
  const id = (overrides.id ?? randomUUID()) as IdUsuario;
  const idConta = (overrides.idConta ?? randomUUID()) as IdContaUsuario;
  const usuario: Usuario = {
    id,
    idPlataforma: ID_PLATAFORMA,
    idConta,
    email: `${id}@example.com`,
    nomeExibicao: 'Test',
    slug: `slug-${id.slice(0, 8)}`,
    criadoEm: fixedDate,
    tutorialCompletadoEm: null,
    ...overrides,
  };
  const conta: Conta = {
    id: idConta,
    idUsuario: id,
    permissoes: ['campaign:admin'],
    criadaEm: fixedDate,
  };
  await repo.saveRegistroDomain({ usuario, conta });
  return usuario;
}

describe('atualizarSlugUsuario (aperture-2ztes)', () => {
  let repo: UsuarioRepositoryMemory;
  const { observability } = createTestObservability();

  beforeEach(() => {
    repo = new UsuarioRepositoryMemory();
  });

  it('updates the slug and returns the updated Usuario', async () => {
    const usuario = await seedUsuario(repo, { slug: 'before-edit' });

    const result = await atualizarSlugUsuario(
      { usuarioRepository: repo, observability },
      { idUsuario: usuario.id, novoSlug: 'after-edit' },
    );

    expect(result.slug).toBe('after-edit');
    expect(result.id).toBe(usuario.id);
    const reloaded = await repo.findUsuarioById(usuario.id);
    expect(reloaded?.slug).toBe('after-edit');
  });

  it('invalid format → UsuarioInputInvalidoError (NOT a 500)', async () => {
    const usuario = await seedUsuario(repo);
    // Leading digit violates SLUG_USUARIO_REGEX (must start with a letter).
    await expect(
      atualizarSlugUsuario(
        { usuarioRepository: repo, observability },
        { idUsuario: usuario.id, novoSlug: '1nvalid' },
      ),
    ).rejects.toBeInstanceOf(UsuarioInputInvalidoError);
  });

  it('uppercase / too-short formats are rejected as UsuarioInputInvalidoError', async () => {
    const usuario = await seedUsuario(repo);
    await expect(
      atualizarSlugUsuario(
        { usuarioRepository: repo, observability },
        { idUsuario: usuario.id, novoSlug: 'AB' },
      ),
    ).rejects.toBeInstanceOf(UsuarioInputInvalidoError);
  });

  it('missing user → UsuarioNaoEncontradoError (typed 404)', async () => {
    await expect(
      atualizarSlugUsuario(
        { usuarioRepository: repo, observability },
        { idUsuario: randomUUID() as IdUsuario, novoSlug: 'valid-slug' },
      ),
    ).rejects.toBeInstanceOf(UsuarioNaoEncontradoError);
  });

  it('taken slug → UsuarioSlugJaExisteError propagates, NO auto-suffix', async () => {
    await seedUsuario(repo, { slug: 'occupied' });
    const editor = await seedUsuario(repo, { slug: 'editor-slug' });

    await expect(
      atualizarSlugUsuario(
        { usuarioRepository: repo, observability },
        { idUsuario: editor.id, novoSlug: 'occupied' },
      ),
    ).rejects.toBeInstanceOf(UsuarioSlugJaExisteError);

    // No auto-suffix: the editor's slug is unchanged (NOT "occupied-2").
    const reloaded = await repo.findUsuarioById(editor.id);
    expect(reloaded?.slug).toBe('editor-slug');
  });
});

describe('verificarDisponibilidadeSlug (aperture-2ztes)', () => {
  let repo: UsuarioRepositoryMemory;
  const { observability } = createTestObservability();

  beforeEach(() => {
    repo = new UsuarioRepositoryMemory();
  });

  it('available slug → { disponivel: true }', async () => {
    const usuario = await seedUsuario(repo);
    const result = await verificarDisponibilidadeSlug(
      { usuarioRepository: repo, observability },
      { idUsuario: usuario.id, slug: 'free-slug' },
    );
    expect(result).toEqual({ disponivel: true });
  });

  it('invalid format → { disponivel: false, motivo: "formato" } (does NOT throw)', async () => {
    const usuario = await seedUsuario(repo);
    const result = await verificarDisponibilidadeSlug(
      { usuarioRepository: repo, observability },
      { idUsuario: usuario.id, slug: 'NOPE_invalid' },
    );
    expect(result).toEqual({ disponivel: false, motivo: 'formato' });
  });

  it('slug taken by another usuario → { disponivel: false, motivo: "em_uso" }', async () => {
    await seedUsuario(repo, { slug: 'taken-here' });
    const caller = await seedUsuario(repo, { slug: 'caller-slug' });

    const result = await verificarDisponibilidadeSlug(
      { usuarioRepository: repo, observability },
      { idUsuario: caller.id, slug: 'taken-here' },
    );
    expect(result).toEqual({ disponivel: false, motivo: 'em_uso' });
  });

  it("re-checking the caller's OWN current slug → available", async () => {
    const caller = await seedUsuario(repo, { slug: 'my-own-slug' });
    const result = await verificarDisponibilidadeSlug(
      { usuarioRepository: repo, observability },
      { idUsuario: caller.id, slug: 'my-own-slug' },
    );
    expect(result).toEqual({ disponivel: true });
  });

  it('a same slug owned only on ANOTHER plataforma is available to this caller', async () => {
    // Owner on a different plataforma holds "cross-plat".
    const ownerId = randomUUID() as IdUsuario;
    await seedUsuario(repo, {
      id: ownerId,
      idPlataforma: ID_PLATAFORMA_OUTRA,
      slug: 'cross-plat',
    });
    const caller = await seedUsuario(repo, { slug: 'caller-here' });

    const result = await verificarDisponibilidadeSlug(
      { usuarioRepository: repo, observability },
      { idUsuario: caller.id, slug: 'cross-plat' },
    );
    expect(result).toEqual({ disponivel: true });
  });

  it('missing caller → UsuarioNaoEncontradoError (typed 404)', async () => {
    await expect(
      verificarDisponibilidadeSlug(
        { usuarioRepository: repo, observability },
        { idUsuario: randomUUID() as IdUsuario, slug: 'whatever' },
      ),
    ).rejects.toBeInstanceOf(UsuarioNaoEncontradoError);
  });
});
