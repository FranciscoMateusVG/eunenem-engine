/**
 * Integration test for fluxo-jornada-completa.
 *
 * Validates the happy-path orchestration across Usuário, Plataforma, Arrecadação,
 * Taxas, Pagamentos and Financeiro. Arrecadação persists in Postgres via
 * Testcontainers; other bounded contexts use in-memory adapters.
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
import { finalizarPagamentoAprovado } from '../../src/use-cases/checkout/finalizar-pagamento-aprovado.js';
import { iniciarPagamentoContribuicao } from '../../src/use-cases/checkout/iniciar-pagamento-contribuicao.js';
import { iniciarRepasseRecebedor } from '../../src/use-cases/checkout/iniciar-repasse-recebedor.js';
import { obterContribuicoesPrecalculadasCampanha } from '../../src/use-cases/checkout/obter-contribuicoes-precalculadas-campanha.js';
import { obterSaldoRecebedor } from '../../src/use-cases/financeiro/obter-saldo-recebedor.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import { matureLancamentosRecebedorForCampanha } from '../helpers/mature-lancamentos-financeiros.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const VALOR_CONTRIBUICAO_CENTS = 8000;
const VALOR_TAXA_CENTS = 400;
const VALOR_TOTAL_CENTS = 8400;

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
  const idRepasse = randomUUID();

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
      titulo: 'Campanha Teste',
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
    idOpcao,
    idContribuicao,
    idPagamento,
    idRepasse,
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

describe('Fluxo — jornada completa de criação de campanha até repasse de saldo do recebedor', () => {
  it('percorre o caminho ideal ponta a ponta entre contextos', async () => {
    const { deps, idCampanha, idContribuicao, idPagamento, idRepasse } = await seedFluxoBase();

    const vitrine = await obterContribuicoesPrecalculadasCampanha(
      {
        campanhaRepository: deps.campanhaRepository,
        contribuicaoRepository: deps.contribuicaoRepository,
        provedorRegraTaxa: deps.provedorRegraTaxa,
        observability: deps.observability,
      },
      { idPlataforma: ID_PLATAFORMA_EUNENEM, idCampanha },
    );

    expect(vitrine.tituloCampanha).toBe('Campanha Teste');
    expect(vitrine.opcoes).toHaveLength(1);
    expect(vitrine.opcoes[0]?.contribuicoes).toHaveLength(1);
    expect(vitrine.opcoes[0]?.contribuicoes[0]).toMatchObject({
      idContribuicao,
      disponivel: true,
      valorContribuicaoCents: VALOR_CONTRIBUICAO_CENTS,
      composicao: {
        feeAmountCents: VALOR_TAXA_CENTS,
        totalPaidCents: VALOR_TOTAL_CENTS,
        receiverAmountCents: VALOR_CONTRIBUICAO_CENTS,
      },
    });

    const { contribuicao, pagamento } = await iniciarPagamentoContribuicao(
      {
        campanhaRepository: deps.campanhaRepository,
        contribuicaoRepository: deps.contribuicaoRepository,
        provedorRegraTaxa: deps.provedorRegraTaxa,
        pagamentoRepository: deps.pagamentoRepository,
        pagamentoEventPublisher: deps.pagamentoEventPublisher,
        checkoutSessionProvider: deps.pagamentoProvider,
        clock,
        observability: deps.observability,
      },
      {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idContribuicao,
        contribuinte: contribuinteValido(),
        metodo: 'pix',
        idPagamento,
        idIntencaoPagamento: randomUUID(),
        returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
      },
    );

    expect(contribuicao.status).toBe('indisponivel');
    expect(contribuicao.contribuinte).toEqual(contribuinteValido());
    expect(pagamento.status).toBe('pendente');
    expect(pagamento.intencao.composicaoValores.totalPaidCents).toBe(VALOR_TOTAL_CENTS);

    const persistedContribuicao = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(persistedContribuicao?.status).toBe('indisponivel');

    const { pagamento: pagamentoAprovado, lancamentos } = await finalizarPagamentoAprovado(
      {
        pagamentoRepository: deps.pagamentoRepository,
        pagamentoProvider: deps.pagamentoProvider,
        pagamentoEventPublisher: deps.pagamentoEventPublisher,
        contribuicaoRepository: deps.contribuicaoRepository,
        campanhaRepository: deps.campanhaRepository,
        livroFinanceiroRepository: deps.livroFinanceiroRepository,
        clock,
        observability: deps.observability,
      },
      { idPagamento },
    );

    expect(pagamentoAprovado.status).toBe('aprovado');
    expect(lancamentos).toHaveLength(2);
    expect(lancamentos.map((l) => l.tipo)).toEqual([
      'credito_saldo_recebedor',
      'credito_receita_plataforma',
    ]);
    expect(lancamentos.find((l) => l.tipo === 'credito_saldo_recebedor')).toMatchObject({
      amountCents: VALOR_CONTRIBUICAO_CENTS,
      status: 'pendente',
    });
    expect(lancamentos.find((l) => l.tipo === 'credito_receita_plataforma')).toMatchObject({
      amountCents: VALOR_TAXA_CENTS,
      status: 'disponivel',
    });

    const saldoPendente = await obterSaldoRecebedor(
      {
        livroFinanceiroRepository: deps.livroFinanceiroRepository,
        observability: deps.observability,
      },
      { idCampanha },
    );
    expect(saldoPendente).toEqual({
      idCampanha,
      valorPendenteCents: VALOR_CONTRIBUICAO_CENTS,
      valorDisponivelCents: 0,
    });

    const maturados = matureLancamentosRecebedorForCampanha(
      deps.livroFinanceiroRepository,
      idCampanha,
    );
    expect(maturados).toBe(1);

    const saldoDisponivel = await obterSaldoRecebedor(
      {
        livroFinanceiroRepository: deps.livroFinanceiroRepository,
        observability: deps.observability,
      },
      { idCampanha },
    );
    expect(saldoDisponivel).toEqual({
      idCampanha,
      valorPendenteCents: 0,
      valorDisponivelCents: VALOR_CONTRIBUICAO_CENTS,
    });

    const repasse = await iniciarRepasseRecebedor(
      {
        campanhaRepository: deps.campanhaRepository,
        recebedorRepository: deps.recebedorRepository,
        livroFinanceiroRepository: deps.livroFinanceiroRepository,
        clock,
        observability: deps.observability,
      },
      {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idRepasse,
        amountCents: VALOR_CONTRIBUICAO_CENTS,
      },
    );

    expect(repasse).toMatchObject({
      id: idRepasse,
      idCampanha,
      amountCents: VALOR_CONTRIBUICAO_CENTS,
      status: 'solicitado',
    });

    const repassePersistido = await deps.livroFinanceiroRepository.findRepasseById(idRepasse);
    expect(repassePersistido?.status).toBe('solicitado');

    const lancamentosPersistidos =
      await deps.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    expect(lancamentosPersistidos).toHaveLength(2);
  });
});
