import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import type { Conta, Usuario } from '../../../src/domain/usuario/entities/usuario.js';
import type {
  IdContaUsuario,
  IdPlataformaReferencia,
  IdUsuario,
} from '../../../src/domain/usuario/value-objects/ids.js';
import { UsuarioNaoEncontradoError } from '../../../src/errors/usuario/nao-encontrado.error.js';
import { marcarTutorialUsuarioComoCompletado } from '../../../src/use-cases/usuario/marcar-tutorial-usuario-como-completado.js';
import { obterStatusTutorialUsuario } from '../../../src/use-cases/usuario/obter-status-tutorial-usuario.js';
import { createTestObservability } from '../../helpers/observability.js';

/**
 * Plan 0018 Phase A (aperture-omswg). Use-case-level tests for the
 * tutorial-status read + the tutorial-completed write. Adapter-level
 * conformance (first-write-wins + idempotency at the SQL layer) is
 * covered by tests/helpers/usuario-repository.conformance.ts; here we
 * verify the use-case wrapper layers on top of it:
 *
 *   - 404-on-unknown-id at the use-case boundary (the repository
 *     methods silently no-op; the use-case translates to a typed
 *     error so the tRPC layer can map to NOT_FOUND).
 *   - obter projects { completado, completadoEm } correctly for both
 *     null and non-null states.
 *   - marcar is idempotent at the use-case level: a second call
 *     returns the ORIGINAL timestamp, not the `agora` value the caller
 *     passed (mirroring the visitor-side contribuinte-projection
 *     first-writer-wins shape).
 */

const ID_PLATAFORMA = randomUUID() as IdPlataformaReferencia;

async function seedUsuario(
  repo: UsuarioRepositoryMemory,
  overrides: Partial<Usuario> = {},
): Promise<Usuario> {
  const id = (overrides.id ?? randomUUID()) as IdUsuario;
  const idConta = (overrides.idConta ?? randomUUID()) as IdContaUsuario;
  const fixedDate = new Date('2026-06-09T12:00:00Z');
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

describe('obterStatusTutorialUsuario (aperture-omswg)', () => {
  let repo: UsuarioRepositoryMemory;
  const { observability } = createTestObservability();

  beforeEach(() => {
    repo = new UsuarioRepositoryMemory();
  });

  it('returns { completado: false, completadoEm: null } for first-time user', async () => {
    const usuario = await seedUsuario(repo);
    const result = await obterStatusTutorialUsuario(
      { usuarioRepository: repo, observability },
      usuario.id,
    );
    expect(result).toEqual({ completado: false, completadoEm: null });
  });

  it('returns { completado: true, completadoEm: <iso> } for completed user', async () => {
    const ts = new Date('2026-06-10T08:00:00.000Z');
    const usuario = await seedUsuario(repo, { tutorialCompletadoEm: ts });
    const result = await obterStatusTutorialUsuario(
      { usuarioRepository: repo, observability },
      usuario.id,
    );
    expect(result).toEqual({
      completado: true,
      completadoEm: ts.toISOString(),
    });
  });

  it('throws UsuarioNaoEncontradoError when idUsuario does not exist', async () => {
    await expect(
      obterStatusTutorialUsuario(
        { usuarioRepository: repo, observability },
        randomUUID() as IdUsuario,
      ),
    ).rejects.toBeInstanceOf(UsuarioNaoEncontradoError);
  });
});

describe('marcarTutorialUsuarioComoCompletado (aperture-omswg)', () => {
  let repo: UsuarioRepositoryMemory;
  const { observability } = createTestObservability();

  beforeEach(() => {
    repo = new UsuarioRepositoryMemory();
  });

  it('flips null → timestamp and returns the persisted shape', async () => {
    const usuario = await seedUsuario(repo);
    const agora = new Date('2026-06-10T15:00:00.000Z');

    const result = await marcarTutorialUsuarioComoCompletado(
      { usuarioRepository: repo, observability },
      usuario.id,
      agora,
    );
    expect(result).toEqual({
      completado: true,
      completadoEm: agora.toISOString(),
    });

    // Persisted state matches the response.
    const reloaded = await repo.findUsuarioById(usuario.id);
    expect(reloaded?.tutorialCompletadoEm?.getTime()).toBe(agora.getTime());
  });

  it('idempotent: second call returns ORIGINAL timestamp, not the new agora', async () => {
    const usuario = await seedUsuario(repo);
    const t1 = new Date('2026-06-10T08:00:00.000Z');
    const t2 = new Date('2026-06-10T20:00:00.000Z');

    const first = await marcarTutorialUsuarioComoCompletado(
      { usuarioRepository: repo, observability },
      usuario.id,
      t1,
    );
    expect(first.completadoEm).toBe(t1.toISOString());

    // Second call with a LATER agora — still returns t1 (first-write-wins).
    const second = await marcarTutorialUsuarioComoCompletado(
      { usuarioRepository: repo, observability },
      usuario.id,
      t2,
    );
    expect(second.completadoEm).toBe(t1.toISOString());

    // Persisted state preserved t1, not overwritten by t2.
    const reloaded = await repo.findUsuarioById(usuario.id);
    expect(reloaded?.tutorialCompletadoEm?.getTime()).toBe(t1.getTime());
  });

  it('throws UsuarioNaoEncontradoError when idUsuario does not exist', async () => {
    await expect(
      marcarTutorialUsuarioComoCompletado(
        { usuarioRepository: repo, observability },
        randomUUID() as IdUsuario,
        new Date(),
      ),
    ).rejects.toBeInstanceOf(UsuarioNaoEncontradoError);
  });
});
