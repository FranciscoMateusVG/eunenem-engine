import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/financeiro/livro-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUCASEI,
  ID_PLATAFORMA_EUNENEM,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../../src/adapters/taxas/regra-provider.memory.js';
import { ArrecadacaoCampanhaNaoEncontradaError } from '../../../src/errors/arrecadacao/campanha-nao-encontrada.error.js';
import { ArrecadacaoContribuicaoNaoEncontradaError } from '../../../src/errors/arrecadacao/contribuicao-nao-encontrada.error.js';
import { PagamentoNaoEncontradoError } from '../../../src/errors/pagamentos/nao-encontrado.error.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { finalizarPagamentoAprovado } from '../../../src/use-cases/checkout/finalizar-pagamento-aprovado.js';
import { iniciarPagamentoContribuicao } from '../../../src/use-cases/checkout/iniciar-pagamento-contribuicao.js';
import { aprovarPagamento } from '../../../src/use-cases/pagamentos/aprovar-pagamento.js';
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

const contribuinteValido = () => ({
  nome: 'Joao Visitante',
  email: 'joao@exemplo.com',
});

/** Builds a pendente pagamento via Phase 2 saga and returns deps + ids. */
async function setupPagamentoPendente(idPlataforma: string, tipoOpcao: 'presente' | 'rifa') {
  const repos = createArrecadacaoMemoryRepos();
  const { campanhaRepository, recebedorRepository, plataformaRepository } = repos;
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const pagamentoProvider = new PagamentoProviderFake({ statusResultado: 'aprovado' });
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

  const idCampanha = randomUUID();
  const idOpcao = randomUUID();
  const idContribuicao = randomUUID();
  const idPagamento = randomUUID();

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
      titulo: 'Campanha Finalize',
    },
  );
  await adicionarOpcaoContribuicao(
    { campanhaRepository, observability: silentObservability },
    { idCampanha, idOpcao, tipo: tipoOpcao },
  );
  await criarContribuicao(
    { campanhaRepository, contribuicaoRepository, clock, observability: silentObservability },
    {
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao: idOpcao,
      nome: 'Fralda',
      valor: 8000,
    },
  );

  await iniciarPagamentoContribuicao(
    {
      campanhaRepository,
      contribuicaoRepository,
      provedorRegraTaxa,
      pagamentoRepository,
      pagamentoEventPublisher,
      checkoutSessionProvider: pagamentoProvider,
      clock,
      observability: silentObservability,
    },
    {
      idPlataforma,
      idCampanha,
      idContribuicao,
      contribuinte: contribuinteValido(),
      metodo: 'pix',
      idPagamento,
      idIntencaoPagamento: randomUUID(),
      returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
    },
  );

  return {
    deps: {
      pagamentoRepository,
      pagamentoProvider,
      pagamentoEventPublisher,
      contribuicaoRepository,
      campanhaRepository,
      livroFinanceiroRepository,
      clock,
      observability: silentObservability,
    },
    idPagamento,
    idCampanha,
    idContribuicao,
  };
}

describe('finalizarPagamentoAprovado — happy path', () => {
  it('approves the pagamento and registers Financeiro effects (eunenem 5% presente)', async () => {
    const { deps, idPagamento, idCampanha, idContribuicao } = await setupPagamentoPendente(
      ID_PLATAFORMA_EUNENEM,
      'presente',
    );

    const { pagamento, lancamentos } = await finalizarPagamentoAprovado(deps, { idPagamento });

    expect(pagamento.status).toBe('aprovado');
    expect(pagamento.transacaoExterna?.status).toBe('aprovado');
    expect(pagamento.intencao.amountCents).toBe(8400);

    expect(lancamentos).toHaveLength(2);
    const recebedorLancamento = lancamentos.find((l) => l.tipo === 'credito_saldo_recebedor');
    const receitaLancamento = lancamentos.find((l) => l.tipo === 'credito_receita_plataforma');
    expect(recebedorLancamento?.amountCents).toBe(8000);
    expect(recebedorLancamento?.idCampanha).toBe(idCampanha);
    expect(recebedorLancamento?.idContribuicao).toBe(idContribuicao);
    expect(receitaLancamento?.amountCents).toBe(400);
  });

  it('locks distinct values for eucasei rifa (8% on R$80 → R$640 receita)', async () => {
    const { deps, idPagamento } = await setupPagamentoPendente(ID_PLATAFORMA_EUCASEI, 'rifa');

    const { pagamento, lancamentos } = await finalizarPagamentoAprovado(deps, { idPagamento });

    expect(pagamento.intencao.amountCents).toBe(8640);
    const receitaLancamento = lancamentos.find((l) => l.tipo === 'credito_receita_plataforma');
    const recebedorLancamento = lancamentos.find((l) => l.tipo === 'credito_saldo_recebedor');
    expect(receitaLancamento?.amountCents).toBe(640);
    expect(recebedorLancamento?.amountCents).toBe(8000);
  });

  it('the lancamentos snapshot reflects the FROZEN price (orchestrator does not re-query RegraTaxa)', async () => {
    const { deps, idPagamento } = await setupPagamentoPendente(ID_PLATAFORMA_EUNENEM, 'presente');

    const { lancamentos } = await finalizarPagamentoAprovado(deps, { idPagamento });

    const total = lancamentos.reduce((sum, l) => sum + l.amountCents, 0);
    expect(total).toBe(8400); // R$80 receiver + R$4 receita = R$84
  });
});

describe('finalizarPagamentoAprovado — error paths', () => {
  it('throws PagamentoNaoEncontradoError for an unknown idPagamento', async () => {
    const { deps } = await setupPagamentoPendente(ID_PLATAFORMA_EUNENEM, 'presente');

    await expect(finalizarPagamentoAprovado(deps, { idPagamento: randomUUID() })).rejects.toThrow(
      PagamentoNaoEncontradoError,
    );
  });

  it('throws ArrecadacaoContribuicaoNaoEncontradaError when contribuição vanished after approval', async () => {
    const { deps, idPagamento, idContribuicao } = await setupPagamentoPendente(
      ID_PLATAFORMA_EUNENEM,
      'presente',
    );

    // simulate a (very) bad data state by ripping the contribuição out
    // mid-flight: build a fresh contribuicaoRepository that never had it
    const blankContribuicaoRepository = new ContribuicaoRepositoryMemory();
    await expect(
      finalizarPagamentoAprovado(
        { ...deps, contribuicaoRepository: blankContribuicaoRepository },
        { idPagamento },
      ),
    ).rejects.toThrow(ArrecadacaoContribuicaoNaoEncontradaError);

    // sanity: idContribuicao is what was missing
    expect(await deps.contribuicaoRepository.findById(idContribuicao)).toBeDefined();
  });

  it('throws ArrecadacaoCampanhaNaoEncontradaError when campanha vanished', async () => {
    const { deps, idPagamento } = await setupPagamentoPendente(ID_PLATAFORMA_EUNENEM, 'presente');

    const blankCampanhaRepository = new (
      await import('../../../src/adapters/arrecadacao/campanha-repository.memory.js')
    ).CampanhaRepositoryMemory();
    await expect(
      finalizarPagamentoAprovado(
        { ...deps, campanhaRepository: blankCampanhaRepository },
        { idPagamento },
      ),
    ).rejects.toThrow(ArrecadacaoCampanhaNaoEncontradaError);
  });
});

describe('finalizarPagamentoAprovado — idempotency contract', () => {
  it('calling twice returns the same pagamento + same lancamento ids', async () => {
    const { deps, idPagamento } = await setupPagamentoPendente(ID_PLATAFORMA_EUNENEM, 'presente');

    const first = await finalizarPagamentoAprovado(deps, { idPagamento });
    const second = await finalizarPagamentoAprovado(deps, { idPagamento });

    expect(second.pagamento.id).toBe(first.pagamento.id);
    expect(second.pagamento.status).toBe('aprovado');
    expect(second.pagamento.transacaoExterna?.id).toBe(first.pagamento.transacaoExterna?.id);

    const firstIds = first.lancamentos.map((l) => l.id).sort();
    const secondIds = second.lancamentos.map((l) => l.id).sort();
    expect(secondIds).toEqual(firstIds);
  });

  it('produces exactly ONE set of lancamentos in the livro even after two finalize calls', async () => {
    const { deps, idPagamento } = await setupPagamentoPendente(ID_PLATAFORMA_EUNENEM, 'presente');

    await finalizarPagamentoAprovado(deps, { idPagamento });
    await finalizarPagamentoAprovado(deps, { idPagamento });

    const lancamentosNoLivro =
      await deps.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    expect(lancamentosNoLivro).toHaveLength(2); // 1 receiver_saldo + 1 receita_plataforma, not 4
  });

  it('does not call the provider on the second invocation (would create duplicate transacaoExterna)', async () => {
    const { deps, idPagamento } = await setupPagamentoPendente(ID_PLATAFORMA_EUNENEM, 'presente');

    const first = await finalizarPagamentoAprovado(deps, { idPagamento });
    const transacaoIdAfterFirst = first.pagamento.transacaoExterna?.id;

    const second = await finalizarPagamentoAprovado(deps, { idPagamento });
    expect(second.pagamento.transacaoExterna?.id).toBe(transacaoIdAfterFirst);
  });

  it('crash-recovery path: pagamento was already aprovado but Financeiro never ran → registers Financeiro on retry', async () => {
    const { deps, idPagamento } = await setupPagamentoPendente(ID_PLATAFORMA_EUNENEM, 'presente');

    // simulate a crash between aprovarPagamento and the Financeiro step:
    // run aprovarPagamento directly (so pagamento becomes 'aprovado'), but
    // NEVER call finalize — so the livro has no lancamentos for it.
    await aprovarPagamento(
      {
        pagamentoRepository: deps.pagamentoRepository,
        pagamentoProvider: deps.pagamentoProvider,
        pagamentoEventPublisher: deps.pagamentoEventPublisher,
        clock: deps.clock,
        observability: deps.observability,
      },
      { idPagamento },
    );
    const lancamentosBefore =
      await deps.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    expect(lancamentosBefore).toEqual([]);

    // now call finalize — it should detect the 'already aprovado' replay
    // path, skip the provider, and register Financeiro effects.
    const result = await finalizarPagamentoAprovado(deps, { idPagamento });

    expect(result.pagamento.status).toBe('aprovado');
    expect(result.lancamentos).toHaveLength(2);

    const lancamentosAfter =
      await deps.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    expect(lancamentosAfter).toHaveLength(2);
  });
});
