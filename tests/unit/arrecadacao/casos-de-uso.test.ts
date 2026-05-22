import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import type { DadosRecebedor } from '../../../src/domain/arrecadacao/campanha.js';
import { ArrecadacaoAdministradorDuplicadoError } from '../../../src/errors/arrecadacao/administrador-duplicado.error.js';
import { ArrecadacaoAdministradorNaoEncontradoError } from '../../../src/errors/arrecadacao/administrador-nao-encontrado.error.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../../src/errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoJaExisteError } from '../../../src/errors/arrecadacao/contribuicao-ja-existe.error.js';
import { ArrecadacaoContribuicaoNaoDisponivelError } from '../../../src/errors/arrecadacao/contribuicao-nao-disponivel.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../../src/errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { ArrecadacaoInputInvalidoError } from '../../../src/errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../../src/errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import { ArrecadacaoOpcaoIdDuplicadoError } from '../../../src/errors/arrecadacao/opcao-id-duplicado.error.js';
import { ArrecadacaoUltimoAdministradorError } from '../../../src/errors/arrecadacao/ultimo-administrador.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adicionarAdministradorCampanha } from '../../../src/use-cases/arrecadacao/adicionar-administrador-campanha.js';
import { adicionarOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { alterarDadosRecebedorCampanha } from '../../../src/use-cases/arrecadacao/alterar-dados-recebedor-campanha.js';
import { alterarValorContribuicao } from '../../../src/use-cases/arrecadacao/alterar-valor-contribuicao.js';
import { associarContribuinteContribuicao } from '../../../src/use-cases/arrecadacao/associar-contribuinte-contribuicao.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { removerAdministradorCampanha } from '../../../src/use-cases/arrecadacao/remover-administrador-campanha.js';
import { createArrecadacaoMemoryRepos } from '../../helpers/arrecadacao-repos.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const dadosRecebedorPadrao = (): DadosRecebedor => ({
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email',
  chavePix: 'maria@exemplo.com',
});

describe('criarCampanha', () => {
  it('creates a campaign with no options', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const id = randomUUID();
    const idsAdministradores = [randomUUID()];
    const dadosRecebedor = dadosRecebedorPadrao();
    const campanha = await criarCampanha(
      {
        campanhaRepository,
        recebedorRepository,
        clock,
        observability: silentObservability,
      },
      {
        id,
        idsAdministradores,
        dadosRecebedor,
        titulo: 'Campanha teste',
      },
    );

    expect(campanha.id).toBe(id);
    expect(campanha.idsAdministradores).toEqual(idsAdministradores);
    expect(campanha.dadosRecebedor).toEqual(dadosRecebedor);
    expect(campanha.opcoes).toEqual([]);
    expect(campanha.criadaEm).toEqual(fixedDate);

    const loaded = await campanhaRepository.findById(id);
    expect(loaded?.titulo).toBe('Campanha teste');
  });

  it('throws ArrecadacaoInputInvalidoError on bad title', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    await expect(
      criarCampanha(
        { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
        {
          id: randomUUID(),
          idsAdministradores: [randomUUID()],
          dadosRecebedor: dadosRecebedorPadrao(),
          titulo: '',
        },
      ),
    ).rejects.toThrow(ArrecadacaoInputInvalidoError);
  });
});

describe('adicionarAdministradorCampanha', () => {
  it('adds an administrator to an existing campaign', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const idCampanha = randomUUID();
    const idAdminExistente = randomUUID();
    const idAdminNovo = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [idAdminExistente],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );

    const updated = await adicionarAdministradorCampanha(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idConta: idAdminNovo },
    );

    expect(updated.idsAdministradores).toEqual([idAdminExistente, idAdminNovo]);
  });

  it('throws when campaign is missing', async () => {
    const { campanhaRepository } = createArrecadacaoMemoryRepos();
    await expect(
      adicionarAdministradorCampanha(
        { campanhaRepository, observability: silentObservability },
        { idCampanha: randomUUID(), idConta: randomUUID() },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws on duplicate administrator', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const idCampanha = randomUUID();
    const idAdmin = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [idAdmin],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );

    await expect(
      adicionarAdministradorCampanha(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idConta: idAdmin },
      ),
    ).rejects.toThrow(ArrecadacaoAdministradorDuplicadoError);
  });
});

describe('removerAdministradorCampanha', () => {
  it('removes an administrator from an existing campaign', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const idCampanha = randomUUID();
    const idAdmin1 = randomUUID();
    const idAdmin2 = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [idAdmin1, idAdmin2],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );

    const updated = await removerAdministradorCampanha(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idConta: idAdmin2 },
    );

    expect(updated.idsAdministradores).toEqual([idAdmin1]);
  });

  it('throws when campaign is missing', async () => {
    const { campanhaRepository } = createArrecadacaoMemoryRepos();
    await expect(
      removerAdministradorCampanha(
        { campanhaRepository, observability: silentObservability },
        { idCampanha: randomUUID(), idConta: randomUUID() },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws when administrator is not on campaign', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const idCampanha = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );

    await expect(
      removerAdministradorCampanha(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idConta: randomUUID() },
      ),
    ).rejects.toThrow(ArrecadacaoAdministradorNaoEncontradoError);
  });

  it('throws when removing the last administrator', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const idCampanha = randomUUID();
    const idAdmin = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [idAdmin],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );

    await expect(
      removerAdministradorCampanha(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idConta: idAdmin },
      ),
    ).rejects.toThrow(ArrecadacaoUltimoAdministradorError);
  });
});

describe('alterarDadosRecebedorCampanha', () => {
  it('replaces receiver data keeping same idCampanha', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const idCampanha = randomUUID();
    const novosDados: DadosRecebedor = {
      nomeTitular: 'Joao Santos',
      tipoChavePix: 'cpf',
      chavePix: '12345678901',
    };

    const criada = await criarCampanha(
      {
        campanhaRepository,
        recebedorRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );

    const updated = await alterarDadosRecebedorCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      { idCampanha, dadosRecebedor: novosDados },
    );

    expect(updated.dadosRecebedor).toEqual(novosDados);
    expect(updated.idRecebedor).not.toBe(criada.idRecebedor);

    const historico = await recebedorRepository.findByCampanhaId(idCampanha);
    expect(historico).toHaveLength(2);
    expect(historico.filter((r) => r.isActive)).toHaveLength(1);
    expect(historico.every((r) => r.idCampanha === idCampanha)).toBe(true);

    const reloaded = await campanhaRepository.findById(idCampanha);
    expect(reloaded?.dadosRecebedor).toEqual(novosDados);
  });

  it('throws when campaign is missing', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    await expect(
      alterarDadosRecebedorCampanha(
        { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
        { idCampanha: randomUUID(), dadosRecebedor: dadosRecebedorPadrao() },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws ArrecadacaoInputInvalidoError on invalid receiver data', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const idCampanha = randomUUID();
    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await expect(
      alterarDadosRecebedorCampanha(
        { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
        {
          idCampanha,
          dadosRecebedor: {
            nomeTitular: 'X',
            tipoChavePix: 'email',
            chavePix: 'nao-e-email',
          },
        },
      ),
    ).rejects.toThrow(ArrecadacaoInputInvalidoError);
  });
});

describe('alterarValorContribuicao', () => {
  it('updates valor on disponivel contribution', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idContribuicao = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, tipo: 'presente' },
    );
    await criarContribuicao(
      {
        campanhaRepository,
        contribuicaoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idContribuicao,
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        nome: 'Fralda',
        valor: 1000,
      },
    );

    const updated = await alterarValorContribuicao(
      { contribuicaoRepository, observability: silentObservability },
      { idContribuicao, valor: 7500 },
    );

    expect(updated.valor).toBe(7500);
    expect(updated.status).toBe('disponivel');
  });

  it('throws when contribution is missing', async () => {
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    await expect(
      alterarValorContribuicao(
        { contribuicaoRepository, observability: silentObservability },
        { idContribuicao: randomUUID(), valor: 100 },
      ),
    ).rejects.toThrow(ArrecadacaoContribuicaoNaoEncontradaError);
  });

  it('throws when contribution is indisponivel', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idContribuicao = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, tipo: 'presente' },
    );
    await criarContribuicao(
      {
        campanhaRepository,
        contribuicaoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idContribuicao,
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        nome: 'Fralda',
        valor: 100,
      },
    );
    await associarContribuinteContribuicao(
      { contribuicaoRepository, observability: silentObservability },
      {
        idContribuicao,
        contribuinte: { nome: 'V', email: 'v@exemplo.com' },
      },
    );

    await expect(
      alterarValorContribuicao(
        { contribuicaoRepository, observability: silentObservability },
        { idContribuicao, valor: 200 },
      ),
    ).rejects.toThrow(ArrecadacaoContribuicaoNaoDisponivelError);
  });

  it('throws ArrecadacaoInputInvalidoError on zero valor', async () => {
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    await expect(
      alterarValorContribuicao(
        { contribuicaoRepository, observability: silentObservability },
        { idContribuicao: randomUUID(), valor: 0 },
      ),
    ).rejects.toThrow(ArrecadacaoInputInvalidoError);
  });
});

describe('adicionarOpcaoContribuicao', () => {
  it('adds an option to an existing campaign', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const idCampanha = randomUUID();
    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );

    const idOpcao = randomUUID();
    const updated = await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      {
        idCampanha,
        idOpcao,
        tipo: 'presente',
      },
    );

    expect(updated.opcoes).toHaveLength(1);
    expect(updated.opcoes[0]?.tipo).toBe('presente');
    expect(updated.opcoes[0]?.id).toBe(idOpcao);
  });

  it('throws when campaign is missing', async () => {
    const { campanhaRepository } = createArrecadacaoMemoryRepos();
    const missingId = randomUUID();
    await expect(
      adicionarOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        {
          idCampanha: missingId,
          idOpcao: randomUUID(),
          tipo: 'presente',
        },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws on duplicate option id on same campaign', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, tipo: 'presente' },
    );
    await expect(
      adicionarOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idOpcao, tipo: 'rifa' },
      ),
    ).rejects.toThrow(ArrecadacaoOpcaoIdDuplicadoError);
  });

  it('throws ArrecadacaoInputInvalidoError on invalid input', async () => {
    const { campanhaRepository } = createArrecadacaoMemoryRepos();
    await expect(
      adicionarOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        {
          idCampanha: 'nao-uuid',
          idOpcao: randomUUID(),
          tipo: 'presente',
        },
      ),
    ).rejects.toThrow(ArrecadacaoInputInvalidoError);
  });
});

describe('criarContribuicao', () => {
  it('creates disponivel contribution with admin input', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idContribuicao = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, tipo: 'presente' },
    );

    const contribuicao = await criarContribuicao(
      {
        campanhaRepository,
        contribuicaoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idContribuicao,
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        nome: 'Fralda',
        valor: 8000,
      },
    );

    expect(contribuicao.valor).toBe(8000);
    expect(contribuicao.nome).toBe('Fralda');
    expect(contribuicao.status).toBe('disponivel');
    expect(contribuicao.contribuinte).toBeNull();
    expect(contribuicao.idOpcaoContribuicao).toBe(idOpcao);
  });

  it('throws ArrecadacaoInputInvalidoError on invalid nome', async () => {
    const { campanhaRepository } = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();

    await expect(
      criarContribuicao(
        {
          campanhaRepository,
          contribuicaoRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          idCampanha: randomUUID(),
          idOpcaoContribuicao: randomUUID(),
          nome: '',
          valor: 100,
        },
      ),
    ).rejects.toThrow(ArrecadacaoInputInvalidoError);
  });

  it('throws when campaign is missing', async () => {
    const { campanhaRepository } = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const missingCampanha = randomUUID();

    await expect(
      criarContribuicao(
        {
          campanhaRepository,
          contribuicaoRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          idCampanha: missingCampanha,
          idOpcaoContribuicao: randomUUID(),
          nome: 'Fralda',
          valor: 100,
        },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws when option not on campaign', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );

    await expect(
      criarContribuicao(
        {
          campanhaRepository,
          contribuicaoRepository,
          clock,
          observability: silentObservability,
        },
        {
          id: randomUUID(),
          idCampanha,
          idOpcaoContribuicao: randomUUID(),
          nome: 'Fralda',
          valor: 100,
        },
      ),
    ).rejects.toThrow(ArrecadacaoOpcaoContribuicaoNaoEncontradaError);
  });

  it('throws when contribution id already exists', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idContribuicao = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, tipo: 'presente' },
    );

    const deps = {
      campanhaRepository,
      contribuicaoRepository,
      clock,
      observability: silentObservability,
    };
    const input = {
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao: idOpcao,
      nome: 'Fralda',
      valor: 100,
    };

    await criarContribuicao(deps, input);
    await expect(criarContribuicao(deps, input)).rejects.toThrow(
      ArrecadacaoContribuicaoJaExisteError,
    );
  });
});

describe('associarContribuinteContribuicao', () => {
  it('associates contributor and marks indisponivel', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idContribuicao = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, tipo: 'presente' },
    );
    await criarContribuicao(
      {
        campanhaRepository,
        contribuicaoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idContribuicao,
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        nome: 'Fralda',
        valor: 8000,
      },
    );

    const updated = await associarContribuinteContribuicao(
      { contribuicaoRepository, observability: silentObservability },
      {
        idContribuicao,
        contribuinte: { nome: 'Visitante', email: 'visitante@exemplo.com' },
      },
    );

    expect(updated.status).toBe('indisponivel');
    expect(updated.contribuinte?.email).toBe('visitante@exemplo.com');
  });

  it('throws when contribution is missing', async () => {
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    await expect(
      associarContribuinteContribuicao(
        { contribuicaoRepository, observability: silentObservability },
        {
          idContribuicao: randomUUID(),
          contribuinte: { nome: 'V', email: 'v@exemplo.com' },
        },
      ),
    ).rejects.toThrow(ArrecadacaoContribuicaoNaoEncontradaError);
  });

  it('throws when contribution is already indisponivel', async () => {
    const { campanhaRepository, recebedorRepository } = createArrecadacaoMemoryRepos();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idContribuicao = randomUUID();

    await criarCampanha(
      { campanhaRepository, recebedorRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, tipo: 'presente' },
    );
    await criarContribuicao(
      {
        campanhaRepository,
        contribuicaoRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idContribuicao,
        idCampanha,
        idOpcaoContribuicao: idOpcao,
        nome: 'Fralda',
        valor: 100,
      },
    );
    await associarContribuinteContribuicao(
      { contribuicaoRepository, observability: silentObservability },
      {
        idContribuicao,
        contribuinte: { nome: 'A', email: 'a@exemplo.com' },
      },
    );

    await expect(
      associarContribuinteContribuicao(
        { contribuicaoRepository, observability: silentObservability },
        {
          idContribuicao,
          contribuinte: { nome: 'B', email: 'b@exemplo.com' },
        },
      ),
    ).rejects.toThrow(ArrecadacaoContribuicaoNaoDisponivelError);
  });
});
