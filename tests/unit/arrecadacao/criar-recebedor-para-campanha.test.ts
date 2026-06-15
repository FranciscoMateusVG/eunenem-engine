import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { criarCampanhaSemRecebedor } from '../../../src/domain/arrecadacao/entities/campanha.js';
import type {
  IdCampanha,
  IdConta,
  IdOpcaoContribuicao,
  IdPlataforma,
} from '../../../src/domain/arrecadacao/value-objects/ids.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../../src/errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../../src/errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoNaoAutorizadoError } from '../../../src/errors/arrecadacao/nao-autorizado.error.js';
import { ArrecadacaoRecebedorJaExisteError } from '../../../src/errors/arrecadacao/recebedor-ja-existe.error.js';
import { criarRecebedorParaCampanha } from '../../../src/use-cases/arrecadacao/criar-recebedor-para-campanha.js';
import { createTestObservability } from '../../helpers/observability.js';

/**
 * Backend half of aperture-kbmel (Solicitar Transferência onboarding
 * embed). Use-case-level tests.
 */

const { observability } = createTestObservability();

function makeRepos() {
  const recebedorRepository = new RecebedorRepositoryMemory();
  return {
    campanhaRepository: new CampanhaRepositoryMemory(recebedorRepository),
    recebedorRepository,
  };
}

async function seedCampanha(
  repos: ReturnType<typeof makeRepos>,
  idAdmin: IdConta,
): Promise<{ idCampanha: IdCampanha; idOpcao: IdOpcaoContribuicao }> {
  const idCampanha = randomUUID() as IdCampanha;
  const idOpcao = randomUUID() as IdOpcaoContribuicao;
  const campanha = criarCampanhaSemRecebedor({
    id: idCampanha,
    idPlataforma: randomUUID() as IdPlataforma,
    titulo: 'Test',
    idsAdministradores: [idAdmin],
    opcoes: [
      {
        id: idOpcao,
        nome: 'Presentes',
        titulo: 'Sua lista',
        criadaEm: new Date('2026-06-10T00:00:00Z'),
      },
    ],
    criadaEm: new Date('2026-06-10T00:00:00Z'),
  });
  await repos.campanhaRepository.save(campanha);
  return { idCampanha, idOpcao };
}

const DADOS_RECEBEDOR = {
  nomeTitular: 'Test Owner',
  tipoChavePix: 'email' as const,
  chavePix: 'owner@example.com',
};

describe('criarRecebedorParaCampanha (aperture-0bynm)', () => {
  let repos: ReturnType<typeof makeRepos>;

  beforeEach(() => {
    repos = makeRepos();
  });

  it('happy path — creates active recebedor + updates campanha snapshot', async () => {
    const idAdmin = randomUUID() as IdConta;
    const { idCampanha } = await seedCampanha(repos, idAdmin);

    const result = await criarRecebedorParaCampanha(
      { ...repos, clock: () => new Date('2026-06-10T12:00:00Z'), observability },
      {
        idCampanha,
        idContaCaller: idAdmin,
        dadosRecebedor: DADOS_RECEBEDOR,
      },
    );

    expect(result.idRecebedor).toBeDefined();
    // Persisted recebedor matches.
    const ativo = await repos.recebedorRepository.findAtivoByCampanhaId(idCampanha);
    expect(ativo).toBeDefined();
    expect(ativo?.dadosRecebedor.chavePix).toBe('owner@example.com');
    expect(ativo?.isActive).toBe(true);
    // Campanha snapshot updated.
    const campanha = await repos.campanhaRepository.findById(idCampanha);
    expect(campanha?.idRecebedor).toBe(result.idRecebedor);
    expect(campanha?.dadosRecebedor?.chavePix).toBe('owner@example.com');
  });

  it('throws ArrecadacaoCampanhaNaoEncontradaError when campanha does not exist', async () => {
    const idAdmin = randomUUID() as IdConta;
    await expect(
      criarRecebedorParaCampanha(
        { ...repos, clock: () => new Date(), observability },
        {
          idCampanha: randomUUID() as IdCampanha,
          idContaCaller: idAdmin,
          dadosRecebedor: DADOS_RECEBEDOR,
        },
      ),
    ).rejects.toBeInstanceOf(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws ArrecadacaoNaoAutorizadoError when caller is not an administrador', async () => {
    const idAdmin = randomUUID() as IdConta;
    const idOutroUsuario = randomUUID() as IdConta;
    const { idCampanha } = await seedCampanha(repos, idAdmin);

    await expect(
      criarRecebedorParaCampanha(
        { ...repos, clock: () => new Date(), observability },
        {
          idCampanha,
          idContaCaller: idOutroUsuario,
          dadosRecebedor: DADOS_RECEBEDOR,
        },
      ),
    ).rejects.toBeInstanceOf(ArrecadacaoNaoAutorizadoError);
  });

  it('throws ArrecadacaoRecebedorJaExisteError when an active recebedor already exists', async () => {
    const idAdmin = randomUUID() as IdConta;
    const { idCampanha } = await seedCampanha(repos, idAdmin);

    await criarRecebedorParaCampanha(
      { ...repos, clock: () => new Date('2026-06-10T08:00:00Z'), observability },
      {
        idCampanha,
        idContaCaller: idAdmin,
        dadosRecebedor: DADOS_RECEBEDOR,
      },
    );

    await expect(
      criarRecebedorParaCampanha(
        { ...repos, clock: () => new Date('2026-06-10T09:00:00Z'), observability },
        {
          idCampanha,
          idContaCaller: idAdmin,
          dadosRecebedor: {
            ...DADOS_RECEBEDOR,
            chavePix: 'other@example.com',
          },
        },
      ),
    ).rejects.toBeInstanceOf(ArrecadacaoRecebedorJaExisteError);
  });

  it('throws ArrecadacaoInputInvalidoError on a malformed dadosRecebedor (e.g. invalid CPF)', async () => {
    const idAdmin = randomUUID() as IdConta;
    const { idCampanha } = await seedCampanha(repos, idAdmin);

    await expect(
      criarRecebedorParaCampanha(
        { ...repos, clock: () => new Date(), observability },
        {
          idCampanha,
          idContaCaller: idAdmin,
          dadosRecebedor: {
            nomeTitular: 'X',
            tipoChavePix: 'cpf',
            chavePix: 'not-a-cpf',
          },
        },
      ),
    ).rejects.toBeInstanceOf(ArrecadacaoInputInvalidoError);
  });

  it('admin guard runs before existence leak — non-admin on existing-recebedor campanha gets nao_autorizado not ja_existe', async () => {
    const idAdmin = randomUUID() as IdConta;
    const idOutroUsuario = randomUUID() as IdConta;
    const { idCampanha } = await seedCampanha(repos, idAdmin);

    // Admin creates a recebedor first.
    await criarRecebedorParaCampanha(
      { ...repos, clock: () => new Date('2026-06-10T08:00:00Z'), observability },
      {
        idCampanha,
        idContaCaller: idAdmin,
        dadosRecebedor: DADOS_RECEBEDOR,
      },
    );

    // Non-admin tries to create — should NOT get RecebedorJaExisteError
    // (that would leak existence). They get NaoAutorizado.
    await expect(
      criarRecebedorParaCampanha(
        { ...repos, clock: () => new Date('2026-06-10T09:00:00Z'), observability },
        {
          idCampanha,
          idContaCaller: idOutroUsuario,
          dadosRecebedor: DADOS_RECEBEDOR,
        },
      ),
    ).rejects.toBeInstanceOf(ArrecadacaoNaoAutorizadoError);
  });
});
