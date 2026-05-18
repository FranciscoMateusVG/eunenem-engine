import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../../src/errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoJaExisteError } from '../../../src/errors/arrecadacao/contribuicao-ja-existe.error.js';
import { ArrecadacaoInputInvalidoError } from '../../../src/errors/arrecadacao/input-invalido.error.js';
import { ArrecadacaoOpcaoContribuicaoNaoEncontradaError } from '../../../src/errors/arrecadacao/opcao-contribuicao-nao-encontrada.error.js';
import { ArrecadacaoOpcaoIdDuplicadoError } from '../../../src/errors/arrecadacao/opcao-id-duplicado.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

describe('criarCampanha', () => {
  it('creates a campaign with no options', async () => {
    const campanhaRepository = new CampanhaRepositoryMemory();
    const id = randomUUID();
    const idContaCriadora = randomUUID();
    const idRecebedor = randomUUID();

    const campanha = await criarCampanha(
      { campanhaRepository, clock, observability: silentObservability },
      {
        id,
        idContaCriadora,
        idRecebedor,
        titulo: 'Campanha teste',
      },
    );

    expect(campanha.id).toBe(id);
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
          idContaCriadora: randomUUID(),
          idRecebedor: randomUUID(),
          titulo: '',
        },
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
        idContaCriadora: randomUUID(),
        idRecebedor: randomUUID(),
        titulo: 'Campanha',
      },
    );

    const idOpcao = randomUUID();
    const updated = await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      {
        idCampanha,
        idOpcao,
        amountCents: 8000,
        rotulo: 'R$ 80',
      },
    );

    expect(updated.opcoes).toHaveLength(1);
    expect(updated.opcoes[0]?.amountCents).toBe(8000);
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
          amountCents: 100,
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
        idContaCriadora: randomUUID(),
        idRecebedor: randomUUID(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, amountCents: 100 },
    );
    await expect(
      adicionarOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idOpcao, amountCents: 200 },
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
        idContaCriadora: randomUUID(),
        idRecebedor: randomUUID(),
        titulo: 'Campanha',
      },
    );
    await expect(
      adicionarOpcaoContribuicao(
        { campanhaRepository, observability: silentObservability },
        { idCampanha, idOpcao: randomUUID(), amountCents: 0 },
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
        idContaCriadora: randomUUID(),
        idRecebedor: randomUUID(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, amountCents: 8000 },
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
        contribuinte: { nomeExibicao: 'Visitante' },
      },
    );

    expect(contribuicao.amountCents).toBe(8000);
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
          contribuinte: { nomeExibicao: 'X' },
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
        idContaCriadora: randomUUID(),
        idRecebedor: randomUUID(),
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
          contribuinte: { nomeExibicao: 'X' },
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
        idContaCriadora: randomUUID(),
        idRecebedor: randomUUID(),
        titulo: 'Campanha',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, amountCents: 100 },
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
      contribuinte: { nomeExibicao: 'A' },
    };

    await criarContribuicao(deps, input);
    await expect(criarContribuicao(deps, input)).rejects.toThrow(
      ArrecadacaoContribuicaoJaExisteError,
    );
  });
});
