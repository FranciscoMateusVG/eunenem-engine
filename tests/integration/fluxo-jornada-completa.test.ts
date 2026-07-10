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
import { PagamentoEventPublisherMemory } from '../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
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
import { esgotada } from '../../src/use-cases/arrecadacao/quantidade-restante.js';
import { finalizarPagamentoAprovado } from '../../src/use-cases/checkout/finalizar-pagamento-aprovado.js';
import { iniciarPagamentoCarrinho } from '../../src/use-cases/checkout/iniciar-pagamento-carrinho.js';
import { iniciarRepasseRecebedor } from '../../src/use-cases/checkout/iniciar-repasse-recebedor.js';
import { obterContribuicoesPrecalculadasCampanha } from '../../src/use-cases/checkout/obter-contribuicoes-precalculadas-campanha.js';
import { obterSaldoRecebedor } from '../../src/use-cases/pagamentos/financeiro/obter-saldo-recebedor.js';
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
  metodo: 'pix' as const,
  nomeTitular: 'Maria Silva',
  cpfTitular: '52998224725',
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
        // Plan 0016 (aperture-eg1s2): the use-case now batch-resolves the
        // esgotada predicate via the Pagamento repo. Fixture was missing this dep.
        pagamentoRepository: deps.pagamentoRepository,
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

    const { contribuicoes, pagamento } = await iniciarPagamentoCarrinho(
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
        itens: [{ idContribuicao, quantidade: 1 }],
        idsItens: [randomUUID()],
        metodo: 'pix',
        idPagamento,
        idIntencaoPagamento: randomUUID(),
        returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
      },
    );

    // Plan 0015/0016: Contribuição no longer carries a `status` enum or a
    // `contribuinte` field. "Disponível" is now derived via esgotada() (no
    // aprovado pagamento has sold the slot yet); contribuinte lives on the
    // pagamento's intenção and is stamped at finalize-time from the webhook.
    const contribuicao = contribuicoes[0];
    expect(contribuicao?.id).toBe(idContribuicao);
    expect(pagamento.intencao.contribuinte).toBeNull();
    expect(pagamento.status).toBe('pendente');
    expect(pagamento.intencao.composicaoValoresAggregate.totalPaidCents).toBe(VALOR_TOTAL_CENTS);

    const esgotadaArgs = {
      pagamentoRepository: deps.pagamentoRepository,
      contribuicaoRepository: deps.contribuicaoRepository,
      observability: deps.observability,
    };
    // Still available: the pendente pagamento does not count toward sold.
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(false);

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
      { idPagamento, contribuinte: contribuinteValido() },
    );

    // Webhook-driven claim happens inside finalize when contribuinte is present:
    // the contribuinte is stamped onto the aprovado pagamento's intenção, and
    // the slot (quantidade=1) is now sold out → esgotada returns true.
    expect(pagamentoAprovado.intencao.contribuinte).toEqual(contribuinteValido());
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(true);

    expect(pagamentoAprovado.status).toBe('aprovado');
    expect(lancamentos).toHaveLength(2);
    expect(lancamentos.map((l) => l.tipo)).toEqual([
      'credito_saldo_recebedor',
      'credito_receita_plataforma',
    ]);
    // Plan 0015/0016: LancamentoFinanceiro no longer carries a `status` enum.
    // Pendente/disponível are now derived from transferidoEm/canceladoEm. A
    // fresh recebedor lançamento is pending (transferidoEm === null); the
    // platform-revenue row is realised immediately (no maturation gate).
    const lancamentoRecebedor = lancamentos.find((l) => l.tipo === 'credito_saldo_recebedor');
    expect(lancamentoRecebedor).toMatchObject({ amountCents: VALOR_CONTRIBUICAO_CENTS });
    expect(lancamentoRecebedor?.transferidoEm).toBeNull();
    expect(lancamentoRecebedor?.canceladoEm).toBeNull();
    expect(lancamentos.find((l) => l.tipo === 'credito_receita_plataforma')).toMatchObject({
      amountCents: VALOR_TAXA_CENTS,
    });

    const saldoPendente = await obterSaldoRecebedor(
      {
        livroFinanceiroRepository: deps.livroFinanceiroRepository,
        observability: deps.observability,
      },
      { idCampanha },
    );
    // Plan 0015/0016: the financeiro FSM collapsed. The recebedor lançamento is
    // repasse-eligible (transferidoEm === null) the moment it's created — there
    // is NO maturation gate flipping it to "disponivel" first. So before the
    // repasse the whole balance is PENDENTE ("a receber").
    expect(saldoPendente).toEqual({
      idCampanha,
      valorPendenteCents: VALOR_CONTRIBUICAO_CENTS,
      valorDisponivelCents: 0,
    });

    // The (now collapsed) maturation helper is a no-op that just reports the
    // count of repasse-eligible recebedor lançamentos.
    const eligiveis = matureLancamentosRecebedorForCampanha(
      deps.livroFinanceiroRepository,
      idCampanha,
    );
    expect(eligiveis).toBe(1);

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

    // A merely SOLICITADO repasse only claims the lançamento (stamps idRepasse);
    // it does NOT stamp transferidoEm — that happens on repasse APPROVAL. So the
    // saldo VO still reports the money as pendente ("a receber") here. The
    // lançamento is no longer re-claimable, but the funds aren't "já transferido"
    // until the repasse is approved.
    const saldoAposSolicitacao = await obterSaldoRecebedor(
      {
        livroFinanceiroRepository: deps.livroFinanceiroRepository,
        observability: deps.observability,
      },
      { idCampanha },
    );
    expect(saldoAposSolicitacao).toEqual({
      idCampanha,
      valorPendenteCents: VALOR_CONTRIBUICAO_CENTS,
      valorDisponivelCents: 0,
    });

    const repassePersistido = await deps.livroFinanceiroRepository.findRepasseById(idRepasse);
    expect(repassePersistido?.status).toBe('solicitado');

    const lancamentosPersistidos =
      await deps.livroFinanceiroRepository.findLancamentosByIdPagamento(idPagamento);
    expect(lancamentosPersistidos).toHaveLength(2);
  });
});
