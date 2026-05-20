import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import type { DadosRecebedor } from '../../../src/domain/arrecadacao/campanha.js';
import { IdRecebedorSchema } from '../../../src/domain/arrecadacao/campanha.js';
import { ArrecadacaoAdministradorDuplicadoError } from '../../../src/errors/arrecadacao/administrador-duplicado.error.js';
import { ArrecadacaoAdministradorNaoEncontradoError } from '../../../src/errors/arrecadacao/administrador-nao-encontrado.error.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../../src/errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoJaExisteError } from '../../../src/errors/arrecadacao/contribuicao-ja-existe.error.js';
import { ArrecadacaoInputInvalidoError } from '../../../src/errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../../src/errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import { ArrecadacaoOpcaoIdDuplicadoError } from '../../../src/errors/arrecadacao/opcao-id-duplicado.error.js';
import { ArrecadacaoUltimoAdministradorError } from '../../../src/errors/arrecadacao/ultimo-administrador.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adicionarAdministradorCampanha } from '../../../src/use-cases/arrecadacao/adicionar-administrador-campanha.js';
import { adicionarOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { alterarDadosRecebedorCampanha } from '../../../src/use-cases/arrecadacao/alterar-dados-recebedor-campanha.js';
import { alterarValorOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/alterar-valor-opcao-contribuicao.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { removerAdministradorCampanha } from '../../../src/use-cases/arrecadacao/remover-administrador-campanha.js';

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
    const campanhaRepository = new CampanhaRepositoryMemory();
    const id = randomUUID();
    const idsAdministradores = [randomUUID()];
    const dadosRecebedor = dadosRecebedorPadrao();
    const idRecebedorGerado = randomUUID();

    const campanha = await criarCampanha(
      {
        campanhaRepository,
        clock,
        gerarIdRecebedor: () => idRecebedorGerado,
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
    expect(campanha.idRecebedor).toBe(idRecebedorGerado);
    expect(IdRecebedorSchema.safeParse(campanha.idRecebedor).success).toBe(true);
    expect(campanha.opcoes).toEqual([]);
    expect(campanha.criadaEm).toEqual(fixedDate);

    const loaded = await campanhaRepository.findById(id);
    expect(loaded?.titulo).toBe('Campanha teste');
  });

  it('throws ArrecadacaoInputInvalidoError on bad title', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    await expect(
      criarCampanha(
        { campanhaRepository, clock, observability: silentObservability },
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
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    const idAdminExistente = randomUUID();
    const idAdminNovo = randomUUID();

    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
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
    const campanhaRepository = new CampanhaRepositoryMemory();
    await expect(
      adicionarAdministradorCampanha(
        { campanhaRepository, observability: silentObservability },
        { idCampanha: randomUUID(), idConta: randomUUID() },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws on duplicate administrator', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    const idAdmin = randomUUID();

    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
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
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    const idAdmin1 = randomUUID();
    const idAdmin2 = randomUUID();

    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
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
    const campanhaRepository = new CampanhaRepositoryMemory();
    await expect(
      removerAdministradorCampanha(
        { campanhaRepository, observability: silentObservability },
        { idCampanha: randomUUID(), idConta: randomUUID() },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws when administrator is not on campaign', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();

    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
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
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    const idAdmin = randomUUID();

    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
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
  it('updates receiver data without changing idRecebedor', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    const idRecebedorFixo = randomUUID();
    const novosDados: DadosRecebedor = {
      nomeTitular: 'Joao Santos',
      tipoChavePix: 'cpf',
      chavePix: '12345678901',
    };

    const criada = await criarCampanha(
      {
        campanhaRepository,
        clock,
        gerarIdRecebedor: () => idRecebedorFixo,
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
      { campanhaRepository, observability: silentObservability },
      { idCampanha, dadosRecebedor: novosDados },
    );

    expect(criada.idRecebedor).toBe(idRecebedorFixo);
    expect(updated.dadosRecebedor).toEqual(novosDados);
    expect(updated.idRecebedor).toBe(idRecebedorFixo);
  });

  it('throws when campaign is missing', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    await expect(
      alterarDadosRecebedorCampanha(
        { campanhaRepository, observability: silentObservability },
        { idCampanha: randomUUID(), dadosRecebedor: dadosRecebedorPadrao() },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws ArrecadacaoInputInvalidoError on invalid receiver data', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await expect(
      alterarDadosRecebedorCampanha(
        { campanhaRepository, observability: silentObservability },
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

describe('alterarValorOpcaoContribuicao', () => {
  it('updates option valor on existing campaign', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();

    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, valor: 1000, tipo: 'presente' },
    );

    const updated = await alterarValorOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, valor: 7500 },
    );

    expect(updated.opcoes[0]?.valor).toBe(7500);
  });

  it('throws when campaign is missing', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    await expect(
      alterarValorOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        { idCampanha: randomUUID(), idOpcao: randomUUID(), valor: 100 },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws when option is missing', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await expect(
      alterarValorOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idOpcao: randomUUID(), valor: 100 },
      ),
    ).rejects.toThrow(ArrecadacaoOpcaoContribuicaoNaoEncontradaError);
  });

  it('throws ArrecadacaoInputInvalidoError on zero valor', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, valor: 100, tipo: 'presente' },
    );
    await expect(
      alterarValorOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idOpcao, valor: 0 },
      ),
    ).rejects.toThrow(ArrecadacaoInputInvalidoError);
  });
});

describe('adicionarOpcaoContribuicao', () => {
  it('adds an option to an existing campaign', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
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
        valor: 8000,
        tipo: 'presente',
      },
    );

    expect(updated.opcoes).toHaveLength(1);
    expect(updated.opcoes[0]?.valor).toBe(8000);
    expect(updated.opcoes[0]?.id).toBe(idOpcao);
  });

  it('throws when campaign is missing', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const missingId = randomUUID();
    await expect(
      adicionarOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        {
          idCampanha: missingId,
          idOpcao: randomUUID(),
          valor: 100,
          tipo: 'presente',
        },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws on duplicate option id on same campaign', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, valor: 100, tipo: 'presente' },
    );
    await expect(
      adicionarOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idOpcao, valor: 200, tipo: 'rifa' },
      ),
    ).rejects.toThrow(ArrecadacaoOpcaoIdDuplicadoError);
  });

  it('throws ArrecadacaoInputInvalidoError on invalid amount', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const idCampanha = randomUUID();
    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await expect(
      adicionarOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idOpcao: randomUUID(), valor: 0, tipo: 'presente' },
      ),
    ).rejects.toThrow(ArrecadacaoInputInvalidoError);
  });
});

describe('criarContribuicao', () => {
  it('creates contribution with amount from option', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idContribuicao = randomUUID();

    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, valor: 8000, tipo: 'presente' },
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
        contribuinte: { nomeExibicao: 'Visitante', email: 'visitante@exemplo.com' },
      },
    );

    expect(contribuicao.valor).toBe(8000);
    expect(contribuicao.status).toBe('pendente_pagamento');
    expect(contribuicao.idOpcaoContribuicao).toBe(idOpcao);
  });

  it('throws ArrecadacaoInputInvalidoError on invalid contributor', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
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
          contribuinte: { nomeExibicao: '' },
        },
      ),
    ).rejects.toThrow(ArrecadacaoInputInvalidoError);
  });

  it('throws when campaign is missing', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
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
          contribuinte: { nomeExibicao: 'X', email: 'x@exemplo.com' },
        },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('throws when option not on campaign', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();

    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
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
          contribuinte: { nomeExibicao: 'X', email: 'x@exemplo.com' },
        },
      ),
    ).rejects.toThrow(ArrecadacaoOpcaoContribuicaoNaoEncontradaError);
  });

  it('throws when contribution id already exists', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const contribuicaoRepository = new ContribuicaoRepositoryMemory();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idContribuicao = randomUUID();

    await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
      {
        id: idCampanha,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, valor: 100, tipo: 'presente' },
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
      contribuinte: { nomeExibicao: 'A', email: 'a@exemplo.com' },
    };

    await criarContribuicao(deps, input);
    await expect(criarContribuicao(deps, input)).rejects.toThrow(
      ArrecadacaoContribuicaoJaExisteError,
    );
  });
});
