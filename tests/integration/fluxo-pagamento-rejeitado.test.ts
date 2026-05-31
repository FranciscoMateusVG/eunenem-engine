/**
 * Integration test for fluxo-pagamento-rejeitado (fluxo 5) — executable spec.
 *
 * Desired behavior (fluxos.txt item 5): checkout started → provider rejects →
 * pagamento `rejeitado`, no Financeiro effects, contribuição `disponivel` again.
 *
 * Uses the checkout orchestrators `iniciarPagamentoContribuicao` +
 * `finalizarPagamentoRejeitado`. The orchestrator is the symmetric
 * counterpart of `finalizarPagamentoAprovado` from plan 0002 — it sequences
 * the Pagamentos rejection AND releases the Arrecadação claim (cross-BC
 * compensation), so the test does NOT need to call
 * `desassociarContribuinteContribuicao` manually.
 *
 * Arrecadação persists in Postgres via Testcontainers; Taxas/Pagamentos/Financeiro/Usuário
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
import { AuthServiceMemoria } from '../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { adicionarOpcaoContribuicao } from '../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { finalizarPagamentoRejeitado } from '../../src/use-cases/checkout/finalizar-pagamento-rejeitado.js';
import { iniciarPagamentoContribuicao } from '../../src/use-cases/checkout/iniciar-pagamento-contribuicao.js';
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
  const pagamentoProvider = new PagamentoProviderFake({ statusResultado: 'rejeitado', clock });
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory();

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
    observability,
  };
}

async function seedFluxoBase() {
  const deps = makeDeps();
  const idCampanha = randomUUID();
  const idOpcao = randomUUID();
  const idContribuicao = randomUUID();
  const idPagamento = randomUUID();
  const idIntencaoPagamento = randomUUID();

  const { conta } = await registrarContaUsuario(
    {
      usuarioRepository: deps.usuarioRepository,
      plataformaRepository: deps.plataformaRepository,
      campanhaRepository: deps.campanhaRepository,
      recebedorRepository: deps.recebedorRepository,
      authService: new AuthServiceMemoria(),
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
      titulo: 'Campanha Pagamento Rejeitado',
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
    idIntencaoPagamento,
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

describe('Fluxo — pagamento rejeitado pelo provedor', () => {
  it('Rejeição de pagamento não deve gerar efeitos financeiros e a contribuição deve ficar disponível', async () => {
    const { deps, idCampanha, idContribuicao, idPagamento, idIntencaoPagamento } =
      await seedFluxoBase();

    const contribuicaoInicial = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoInicial?.status).toBe('disponivel');
    expect(contribuicaoInicial?.contribuinte).toBeNull();

    const checkoutDeps = {
      campanhaRepository: deps.campanhaRepository,
      contribuicaoRepository: deps.contribuicaoRepository,
      provedorRegraTaxa: deps.provedorRegraTaxa,
      pagamentoRepository: deps.pagamentoRepository,
      pagamentoEventPublisher: deps.pagamentoEventPublisher,
      checkoutSessionProvider: deps.pagamentoProvider,
      clock,
      observability: deps.observability,
    };

    const { contribuicao: contribuicaoReservada, pagamento: pagamentoPendente } =
      await iniciarPagamentoContribuicao(checkoutDeps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idContribuicao,
        contribuinte: contribuinteValido(),
        metodo: 'pix',
        idPagamento,
        idIntencaoPagamento,
        returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
      });

    expect(contribuicaoReservada.status).toBe('indisponivel');
    expect(pagamentoPendente.status).toBe('pendente');

    expect(deps.pagamentoEventPublisher.getEventosPublicados()).toHaveLength(1);
    expect(deps.pagamentoEventPublisher.getEventosPublicados()[0]?.tipo).toBe(
      'payment.intent_created',
    );

    const { pagamento: pagamentoRejeitado } = await finalizarPagamentoRejeitado(
      {
        pagamentoRepository: deps.pagamentoRepository,
        pagamentoProvider: deps.pagamentoProvider,
        pagamentoEventPublisher: deps.pagamentoEventPublisher,
        contribuicaoRepository: deps.contribuicaoRepository,
        campanhaRepository: deps.campanhaRepository,
        clock,
        observability: deps.observability,
      },
      { idPagamento },
    );

    expect(pagamentoRejeitado.status).toBe('rejeitado');
    expect(pagamentoRejeitado.transacaoExterna?.status).toBe('rejeitado');

    const pagamentoPersistido = await deps.pagamentoRepository.findById(idPagamento);
    expect(pagamentoPersistido?.status).toBe('rejeitado');

    const eventos = deps.pagamentoEventPublisher.getEventosPublicados();
    expect(eventos).toHaveLength(2);
    expect(eventos.map((e) => e.tipo)).toEqual(['payment.intent_created', 'payment.rejected']);

    const lancamentos =
      await deps.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    expect(lancamentos).toHaveLength(0);

    const saldo = await obterSaldoRecebedor(
      {
        livroFinanceiroRepository: deps.livroFinanceiroRepository,
        observability: deps.observability,
      },
      { idCampanha },
    );
    expect(saldo).toEqual({
      idCampanha,
      valorPendenteCents: 0,
      valorDisponivelCents: 0,
    });

    const receitaPlataforma =
      await deps.livroFinanceiroRepository.findLancamentosReceitaPlataforma();
    expect(receitaPlataforma).toHaveLength(0);

    const contribuicaoFinal = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoFinal?.status).toBe('disponivel');
    expect(contribuicaoFinal?.contribuinte).toBeNull();
  });
});
