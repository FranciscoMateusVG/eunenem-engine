import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import type { Conta, Usuario } from '../../../src/domain/usuario/entities/usuario.js';
import type {
  IdContaUsuario,
  IdPlataformaReferencia,
  IdUsuario,
} from '../../../src/domain/usuario/value-objects/ids.js';
import type { PendenciaDesativacao } from '../../../src/domain/usuario/value-objects/pendencia-desativacao.js';
import { ContaComPendenciasFinanceirasError } from '../../../src/errors/usuario/conta-com-pendencias.error.js';
import { UsuarioNaoEncontradoError } from '../../../src/errors/usuario/nao-encontrado.error.js';
import { desativarContaUsuario } from '../../../src/use-cases/usuario/desativar-conta-usuario.js';
import { createTestObservability } from '../../helpers/observability.js';

const ID_PLATAFORMA = randomUUID() as IdPlataformaReferencia;

async function seedUsuario(repo: UsuarioRepositoryMemory): Promise<Usuario> {
  const id = randomUUID() as IdUsuario;
  const idConta = randomUUID() as IdContaUsuario;
  const criadoEm = new Date('2026-09-01T12:00:00.000Z');
  const usuario: Usuario = {
    id,
    idPlataforma: ID_PLATAFORMA,
    idConta,
    email: `${id}@example.com`,
    nomeExibicao: 'Conta ativa',
    slug: `conta-${id.slice(0, 8)}`,
    criadoEm,
    tutorialCompletadoEm: null,
    onboardingConcluidoEm: null,
  };
  const conta: Conta = {
    id: idConta,
    idUsuario: id,
    permissoes: ['campaign:admin'],
    criadaEm: criadoEm,
  };
  await repo.saveRegistroDomain({ usuario, conta });
  return usuario;
}

describe('desativarContaUsuario', () => {
  let repo: UsuarioRepositoryMemory;
  let pendencias: PendenciaDesativacao[];
  const { observability } = createTestObservability();
  const deps = () => ({
    usuarioRepository: repo,
    pendenciasRepository: { listarPendencias: async () => pendencias },
    observability,
  });

  beforeEach(() => {
    repo = new UsuarioRepositoryMemory();
    pendencias = [];
  });

  it('refuses while an owned campaign has pending money, keeping the account active', async () => {
    const usuario = await seedUsuario(repo);
    pendencias = ['saldo_a_sacar', 'resgate_em_andamento'];

    const error = await desativarContaUsuario(deps(), usuario.id, new Date()).catch((e) => e);

    expect(error).toBeInstanceOf(ContaComPendenciasFinanceirasError);
    expect(error.pendencias).toEqual(['saldo_a_sacar', 'resgate_em_andamento']);
    expect((await repo.findUsuarioById(usuario.id))?.desativadoEm).toBeUndefined();
  });

  it('soft-disables the account and returns the persisted timestamp', async () => {
    const usuario = await seedUsuario(repo);
    const agora = new Date('2026-09-25T09:30:00.000Z');

    await expect(desativarContaUsuario(deps(), usuario.id, agora)).resolves.toEqual({
      desativadoEm: agora.toISOString(),
    });
    expect((await repo.findUsuarioById(usuario.id))?.desativadoEm?.getTime()).toBe(agora.getTime());
  });

  it('is idempotent and keeps the original deactivation timestamp', async () => {
    const usuario = await seedUsuario(repo);
    const t1 = new Date('2026-09-25T09:30:00.000Z');
    const t2 = new Date('2026-09-25T10:30:00.000Z');

    await desativarContaUsuario(deps(), usuario.id, t1);
    const second = await desativarContaUsuario(deps(), usuario.id, t2);

    expect(second).toEqual({ desativadoEm: t1.toISOString() });
  });

  it('rejects an unknown usuario', async () => {
    await expect(
      desativarContaUsuario(deps(), randomUUID() as IdUsuario, new Date()),
    ).rejects.toBeInstanceOf(UsuarioNaoEncontradoError);
  });
});
