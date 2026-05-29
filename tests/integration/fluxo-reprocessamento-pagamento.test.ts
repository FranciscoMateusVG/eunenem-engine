/**
 * Integration test for fluxo-reprocessamento-pagamento-aprovado (fluxo 6).
 *
 * Validates idempotent replay when the same payment approval is processed twice:
 * Pagamento stays approved, Financeiro does not duplicate lancamentos, receiver
 * balance or platform revenue.
 *
 * Arrecadação persists in Postgres via Testcontainers; Taxas/Pagamentos/Financeiro
 * use in-memory adapters.
 *
 * Test isolation: beforeEach truncates arrecadação tables and rebuilds in-memory
 * state through makeDeps(). Any test can run independently in any order.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/financeiro/livro-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../src/adapters/pagamentos/event-publisher.memory.js';
import { PagamentoProviderFake } from '../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../src/adapters/taxas/regra-provider.memory.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { adicionarOpcaoContribuicao } from '../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { finalizarPagamentoAprovado } from '../../src/use-cases/checkout/finalizar-pagamento-aprovado.js';
import { iniciarPagamentoContribuicao } from '../../src/use-cases/checkout/iniciar-pagamento-contribuicao.js';
import { obterReceitaPlataforma } from '../../src/use-cases/financeiro/obter-receita-plataforma.js';
import { obterSaldoRecebedor } from '../../src/use-cases/financeiro/obter-saldo-recebedor.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const VALOR_CONTRIBUICAO_CENTS = 8000;
const VALOR_TAXA_CENTS = 400;

const dadosRecebedorPadrao = () => ({
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
});

const contribuinteValido = () => ({
  nome: 'Joao Visitante',
  email: 'joao@exemplo.com',
});

function makeDeps() {
  const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
  const campanhaRepository = new CampanhaRepositoryPostgres(testDb.db, recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryPostgres(testDb.db);
  const plataformaRepository = new PlataformaRepositoryMemory();
  const usuarioRepository = new UsuarioRepositoryMemory();
  const provedorRegraTaxa = new ProvedorRegraTaxaMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const pagamentoProvider = new PagamentoProviderFake({ statusResultado: 'aprovado', clock });
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory(recebedorRepository);

  const observability = testObs.observability;

  return {
    recebedorRepository,
    campanhaRepository,
    contribuicaoRepository,
    plataformaRepository,
    usuarioRepository,
    provedorRegraTaxa,
    pagamentoRepository,
    pagamentoEventPublisher,
    pagamentoProvider,
    livroFinanceiroRepository,
    clock,
    observability,
  };
}

async function seedFluxoBase() {
  const deps = makeDeps();
  const idCampanha = randomUUID();
  const idOpcao = randomUUID();
  const idContribuicao = randomUUID();
  const idPagamento = randomUUID();

  const { conta } = await registrarContaUsuario(
    {
      usuarioRepository: deps.usuarioRepository,
      plataformaRepository: deps.plataformaRepository,
      clock,
      observability: deps.observability,
    },
    {
      idUsuario: randomUUID(),
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idConta: randomUUID(),
      email: 'admin@exemplo.com',
      nomeExibicao: 'Admin Fluxo',
      senhaSimulada: 'senha-teste',
    },
  );

  await criarCampanha(
    {
      campanhaRepository: deps.campanhaRepository,
      recebedorRepository: deps.recebedorRepository,
      plataformaRepository: deps.plataformaRepository,
      clock,
      observability: deps.observability,
    },
    {
      id: idCampanha,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idsAdministradores: [conta.id],
      dadosRecebedor: dadosRecebedorPadrao(),
      titulo: 'Campanha Reprocessamento',
    },
  );

  await adicionarOpcaoContribuicao(
    { campanhaRepository: deps.campanhaRepository, observability: deps.observability },
    { idCampanha, idOpcao, tipo: 'presente' },
  );

  await criarContribuicao(
    {
      campanhaRepository: deps.campanhaRepository,
      contribuicaoRepository: deps.contribuicaoRepository,
      clock,
      observability: deps.observability,
    },
    {
      id: idContribuicao,
      idCampanha,
      idOpcaoContribuicao: idOpcao,
      nome: 'Fralda',
      valor: VALOR_CONTRIBUICAO_CENTS,
    },
  );

  return {
    deps,
    idCampanha,
    idContribuicao,
    idPagamento,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

beforeEach(async () => {
  await truncateArrecadacaoTables(testDb.db);
  testObs.reset();
});

describe('Fluxo — reprocessamento de pagamento aprovado', () => {
  it('Mantém pagamento aprovado e não duplica efeitos entre Pagamentos e Financeiro ao reprocessar', async () => {
    const { deps, idCampanha, idContribuicao, idPagamento } = await seedFluxoBase();

    const checkoutDeps = {
      campanhaRepository: deps.campanhaRepository,
      contribuicaoRepository: deps.contribuicaoRepository,
      provedorRegraTaxa: deps.provedorRegraTaxa,
      pagamentoRepository: deps.pagamentoRepository,
      pagamentoEventPublisher: deps.pagamentoEventPublisher,
      clock,
      observability: deps.observability,
    };

    const finalizeDeps = {
      pagamentoRepository: deps.pagamentoRepository,
      pagamentoProvider: deps.pagamentoProvider,
      pagamentoEventPublisher: deps.pagamentoEventPublisher,
      contribuicaoRepository: deps.contribuicaoRepository,
      campanhaRepository: deps.campanhaRepository,
      livroFinanceiroRepository: deps.livroFinanceiroRepository,
      clock,
      observability: deps.observability,
    };

    const { pagamento } = await iniciarPagamentoContribuicao(checkoutDeps, {
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      idCampanha,
      idContribuicao,
      contribuinte: contribuinteValido(),
      metodo: 'pix',
      idPagamento,
      idIntencaoPagamento: randomUUID(),
    });

    expect(pagamento.status).toBe('pendente');

    const first = await finalizarPagamentoAprovado(finalizeDeps, { idPagamento });

    expect(first.pagamento.status).toBe('aprovado');
    expect(first.lancamentos).toHaveLength(2);
    expect(first.lancamentos.map((l) => l.tipo)).toEqual([
      'credito_saldo_recebedor',
      'credito_receita_plataforma',
    ]);
    expect(first.lancamentos.find((l) => l.tipo === 'credito_saldo_recebedor')).toMatchObject({
      amountCents: VALOR_CONTRIBUICAO_CENTS,
    });
    expect(first.lancamentos.find((l) => l.tipo === 'credito_receita_plataforma')).toMatchObject({
      amountCents: VALOR_TAXA_CENTS,
    });

    const saldoBaseline = await obterSaldoRecebedor(
      {
        livroFinanceiroRepository: deps.livroFinanceiroRepository,
        observability: deps.observability,
      },
      { idCampanha },
    );
    expect(saldoBaseline).toEqual({
      idCampanha,
      valorPendenteCents: VALOR_CONTRIBUICAO_CENTS,
      valorDisponivelCents: 0,
    });

    const receitaBaseline = await obterReceitaPlataforma({
      livroFinanceiroRepository: deps.livroFinanceiroRepository,
      observability: deps.observability,
    });
    expect(receitaBaseline).toEqual({ totalAmountCents: VALOR_TAXA_CENTS });

    // Reprocessing payment
    const second = await finalizarPagamentoAprovado(finalizeDeps, { idPagamento });

    expect(second.pagamento.status).toBe('aprovado');
    expect(second.lancamentos).toHaveLength(2);
    expect(second.lancamentos.map((l) => l.id)).toEqual(first.lancamentos.map((l) => l.id));

    const pagamentoPersistido = await deps.pagamentoRepository.findById(idPagamento);
    expect(pagamentoPersistido?.status).toBe('aprovado');

    const lancamentosPersistidos =
      await deps.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    expect(lancamentosPersistidos).toHaveLength(2);

    const saldoAposReplay = await obterSaldoRecebedor(
      {
        livroFinanceiroRepository: deps.livroFinanceiroRepository,
        observability: deps.observability,
      },
      { idCampanha },
    );
    expect(saldoAposReplay).toEqual(saldoBaseline);

    const receitaAposReplay = await obterReceitaPlataforma({
      livroFinanceiroRepository: deps.livroFinanceiroRepository,
      observability: deps.observability,
    });
    expect(receitaAposReplay).toEqual(receitaBaseline);
  });
});
