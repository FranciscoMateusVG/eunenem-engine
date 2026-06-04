import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../../src/errors/arrecadacao/campanha-nao-encontrada.error.js';
import { CheckoutPlataformaMismatchError } from '../../../src/errors/checkout/plataforma-mismatch.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { obterContribuicoesPrecalculadasCampanha } from '../../../src/use-cases/checkout/obter-contribuicoes-precalculadas-campanha.js';
import { createArrecadacaoMemoryRepos } from '../../helpers/arrecadacao-repos.js';

const silentObservability = {
  logger: new NoopLogger(),
  tracer: noopTracer(),
};

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const dadosRecebedorPadrao = () => ({
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
});

async function seedCampanha(idPlataforma: string) {
  const repos = createArrecadacaoMemoryRepos();
  const { campanhaRepository, recebedorRepository, plataformaRepository } = repos;
  const contribuicaoRepository = new (
    await import('../../../src/adapters/arrecadacao/contribuicao-repository.memory.js')
  ).ContribuicaoRepositoryMemory();
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory();
  // Plan 0015 (aperture-ucgok): the use-case now derives `disponivel` from
  // a batch EXISTS query against pagamentos. With no aprovado pagamentos
  // seeded, every contribuição reports `disponivel: true`.
  const pagamentoRepository = new PagamentoRepositoryMemory();

  const idCampanha = randomUUID();
  const idOpcaoPresente = randomUUID();
  const idOpcaoRifa = randomUUID();

  await criarCampanha(
    {
      campanhaRepository,
      recebedorRepository,
      plataformaRepository,
      clock,
      observability: silentObservability,
    },
    {
      id: idCampanha,
      idPlataforma,
      idsAdministradores: [randomUUID()],
      dadosRecebedor: dadosRecebedorPadrao(),
      titulo: 'Campanha Teste',
    },
  );

  await adicionarOpcaoContribuicao(
    { campanhaRepository, observability: silentObservability },
    { idCampanha, idOpcao: idOpcaoPresente, tipo: 'presente' },
  );

  await adicionarOpcaoContribuicao(
    { campanhaRepository, observability: silentObservability },
    { idCampanha, idOpcao: idOpcaoRifa, tipo: 'rifa' },
  );

  const idContribFralda = randomUUID();
  await criarContribuicao(
    { campanhaRepository, contribuicaoRepository, clock, observability: silentObservability },
    {
      id: idContribFralda,
      idCampanha,
      idOpcaoContribuicao: idOpcaoPresente,
      nome: 'Fralda',
      valor: 8000,
    },
  );

  const idContribRifa = randomUUID();
  await criarContribuicao(
    { campanhaRepository, contribuicaoRepository, clock, observability: silentObservability },
    {
      id: idContribRifa,
      idCampanha,
      idOpcaoContribuicao: idOpcaoRifa,
      nome: 'Bilhete',
      valor: 8000,
    },
  );

  return {
    deps: {
      campanhaRepository,
      contribuicaoRepository,
      provedorRegraTaxa,
      pagamentoRepository,
      observability: silentObservability,
    },
    plataformaRepository,
    idCampanha,
    idOpcaoPresente,
    idOpcaoRifa,
    idContribFralda,
    idContribRifa,
  };
}

describe('obterContribuicoesPrecalculadasCampanha', () => {
  it('returns plataforma-scoped DTO with composição per contribuição (eunenem 5% on all tipos)', async () => {
    const { deps, idCampanha, idOpcaoPresente, idOpcaoRifa, idContribFralda, idContribRifa } =
      await seedCampanha(ID_PLATAFORMA_EUNENEM);

    const result = await obterContribuicoesPrecalculadasCampanha(deps, {
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idCampanha,
    });

    expect(result.idPlataforma).toBe(ID_PLATAFORMA_EUNENEM);
    expect(result.idCampanha).toBe(idCampanha);
    expect(result.tituloCampanha).toBe('Campanha Teste');
    expect(result.opcoes).toHaveLength(2);

    const presente = result.opcoes.find((o) => o.idOpcao === idOpcaoPresente);
    const rifa = result.opcoes.find((o) => o.idOpcao === idOpcaoRifa);

    expect(presente?.tipo).toBe('presente');
    expect(presente?.contribuicoes).toHaveLength(1);
    expect(presente?.contribuicoes[0]).toMatchObject({
      idContribuicao: idContribFralda,
      nome: 'Fralda',
      valorContribuicaoCents: 8000,
      disponivel: true,
      composicao: {
        contributionAmountCents: 8000,
        feeAmountCents: 400,
        totalPaidCents: 8400,
        receiverAmountCents: 8000,
        responsavelTaxa: 'contribuinte',
      },
    });

    expect(rifa?.tipo).toBe('rifa');
    expect(rifa?.contribuicoes[0]).toMatchObject({
      idContribuicao: idContribRifa,
      composicao: { feeAmountCents: 400, totalPaidCents: 8400 },
    });
  });

  it('produces distinct composições per plataforma (eucasei: 6% presente, 8% rifa)', async () => {
    const { deps, idCampanha, idOpcaoPresente, idOpcaoRifa } =
      await seedCampanha(ID_PLATAFORMA_EUCASEI);

    const result = await obterContribuicoesPrecalculadasCampanha(deps, {
      idPlataforma: ID_PLATAFORMA_EUCASEI,
      idCampanha,
    });

    const presente = result.opcoes.find((o) => o.idOpcao === idOpcaoPresente);
    const rifa = result.opcoes.find((o) => o.idOpcao === idOpcaoRifa);

    expect(presente?.contribuicoes[0]?.composicao).toMatchObject({
      feeAmountCents: 480,
      totalPaidCents: 8480,
    });
    expect(rifa?.contribuicoes[0]?.composicao).toMatchObject({
      feeAmountCents: 640,
      totalPaidCents: 8640,
    });
  });

  it('throws CheckoutPlataformaMismatchError when input plataforma differs from campanha plataforma', async () => {
    const { deps, idCampanha } = await seedCampanha(ID_PLATAFORMA_EUNENEM);

    await expect(
      obterContribuicoesPrecalculadasCampanha(deps, {
        idPlataforma: ID_PLATAFORMA_EUCASEI,
        idCampanha,
      }),
    ).rejects.toThrow(CheckoutPlataformaMismatchError);
  });

  it('throws ArrecadacaoCampanhaNaoEncontradaError for an unknown campanha', async () => {
    const { deps } = await seedCampanha(ID_PLATAFORMA_EUNENEM);

    await expect(
      obterContribuicoesPrecalculadasCampanha(deps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha: randomUUID(),
      }),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });

  it('returns empty contribuições per opção when the campanha has none yet', async () => {
    const repos = createArrecadacaoMemoryRepos();
    const { campanhaRepository, recebedorRepository, plataformaRepository } = repos;
    const contribuicaoRepository = new (
      await import('../../../src/adapters/arrecadacao/contribuicao-repository.memory.js')
    ).ContribuicaoRepositoryMemory();
    const provedorRegraTaxa = new ProvedorRegraTaxaMemory();
    const pagamentoRepository = new PagamentoRepositoryMemory();

    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    await criarCampanha(
      {
        campanhaRepository,
        recebedorRepository,
        plataformaRepository,
        clock,
        observability: silentObservability,
      },
      {
        id: idCampanha,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idsAdministradores: [randomUUID()],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Vazia',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository, observability: silentObservability },
      { idCampanha, idOpcao, tipo: 'presente' },
    );

    const result = await obterContribuicoesPrecalculadasCampanha(
      {
        campanhaRepository,
        contribuicaoRepository,
        provedorRegraTaxa,
        pagamentoRepository,
        observability: silentObservability,
      },
      { idPlataforma: ID_PLATAFORMA_EUNENEM, idCampanha },
    );

    expect(result.opcoes).toHaveLength(1);
    expect(result.opcoes[0]?.contribuicoes).toEqual([]);
  });

  it('rejects when input is missing required fields (Zod boundary)', async () => {
    const { deps } = await seedCampanha(ID_PLATAFORMA_EUNENEM);

    await expect(
      obterContribuicoesPrecalculadasCampanha(deps, {
        idPlataforma: 'not-a-uuid' as never,
        idCampanha: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});
