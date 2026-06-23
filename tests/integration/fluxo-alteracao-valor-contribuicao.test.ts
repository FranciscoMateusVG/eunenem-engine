/**
 * Integration test for fluxo-alteracao-valor-contribuicao (fluxo 7).
 *
 * Validates that an administrator can change a contribution's value while it is
 * `disponivel`. Plan 0015 (aperture-ucgok) removed the status FSM guard, so the
 * change is ALSO permitted after the slot becomes `indisponivel` — already-approved
 * pagamentos preserve the original value in their composicaoValores snapshot, so a
 * later edit does not retroactively change what the contribuinte paid.
 *
 * Arrecadação persists in Postgres via Testcontainers; Taxas/Pagamentos/Usuário
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
import { alterarValorContribuicao } from '../../src/use-cases/arrecadacao/alterar-valor-contribuicao.js';
import { criarCampanha } from '../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { esgotada } from '../../src/use-cases/arrecadacao/quantidade-restante.js';
import { finalizarPagamentoAprovado } from '../../src/use-cases/checkout/finalizar-pagamento-aprovado.js';
import { iniciarPagamentoCarrinho } from '../../src/use-cases/checkout/iniciar-pagamento-carrinho.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const VALOR_INICIAL_CENTS = 8000;
const VALOR_APOS_ALTERACAO_CENTS = 12000;
const VALOR_ALTERACAO_CENTS = 15000;

const dadosRecebedorPadrao = () => ({
  metodo: 'pix' as const,
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
});

const contribuinteVisitante = () => ({
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
      titulo: 'Campanha Alteracao Valor',
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
      valor: VALOR_INICIAL_CENTS,
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

describe('Fluxo — alteração de valor antes e depois do checkout', () => {
  it('Deve permitir alterar valor da contribuição enquanto disponível e também após checkout iniciado (FSM guard removido no Plan 0015)', async () => {
    const { deps, idCampanha, idContribuicao, idPagamento, idIntencaoPagamento } =
      await seedFluxoBase();

    // Plan 0015/0016: Contribuição has no `status` field; availability is
    // derived via esgotada(). The freshly-seeded slot is available.
    const esgotadaArgs = {
      pagamentoRepository: deps.pagamentoRepository,
      contribuicaoRepository: deps.contribuicaoRepository,
      observability: deps.observability,
    };
    const contribuicaoInicial = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoInicial?.valor).toBe(VALOR_INICIAL_CENTS);
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(false);

    const contribuicaoAlterada = await alterarValorContribuicao(
      { contribuicaoRepository: deps.contribuicaoRepository, observability: deps.observability },
      { idContribuicao, valor: VALOR_APOS_ALTERACAO_CENTS },
    );

    expect(contribuicaoAlterada.valor).toBe(VALOR_APOS_ALTERACAO_CENTS);

    const contribuicaoPersistida = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoPersistida?.valor).toBe(VALOR_APOS_ALTERACAO_CENTS);
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(false);

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

    const contribuinte = contribuinteVisitante();

    // Saga no longer claims the contribuição at checkout-start (Plan 0016).
    const { contribuicoes: contribuicoesAposSaga, pagamento } = await iniciarPagamentoCarrinho(
      checkoutDeps,
      {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        itens: [{ idContribuicao, quantidade: 1 }],
        idsItens: [randomUUID()],
        metodo: 'pix',
        idPagamento,
        idIntencaoPagamento,
        returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
      },
    );

    expect(contribuicoesAposSaga[0]?.id).toBe(idContribuicao);
    expect(contribuicoesAposSaga[0]?.valor).toBe(VALOR_APOS_ALTERACAO_CENTS);
    expect(pagamento.status).toBe('pendente');
    // A pendente pagamento doesn't sell the slot.
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(false);

    // The webhook fires → pagamento settles to aprovado → slot is now sold out
    // (the contribuinte is stamped onto the aprovado pagamento's intenção; the
    // contribuição itself no longer carries status/contribuinte).
    const { pagamento: pagamentoAprovado } = await finalizarPagamentoAprovado(
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
      { idPagamento, contribuinte },
    );
    expect(pagamentoAprovado.intencao.contribuinte).toEqual(contribuinte);
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(true);

    // Plan 0015 (aperture-ucgok): the status FSM guard was removed. Editing the
    // value AFTER the slot is sold (esgotada) now SUCCEEDS (it used to throw
    // ArrecadacaoContribuicaoNaoDisponivelError, which no longer exists). The
    // already-settled pagamento keeps the original value in its
    // composicaoValoresAggregate snapshot, so this edit is non-retroactive.
    const contribuicaoAposEsgotada = await alterarValorContribuicao(
      { contribuicaoRepository: deps.contribuicaoRepository, observability: deps.observability },
      { idContribuicao, valor: VALOR_ALTERACAO_CENTS },
    );
    expect(contribuicaoAposEsgotada.valor).toBe(VALOR_ALTERACAO_CENTS);

    const contribuicaoFinal = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoFinal?.valor).toBe(VALOR_ALTERACAO_CENTS);
    // Still sold out (the value edit doesn't change the aprovado pagamento).
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(true);
    // The aprovado pagamento preserved the value paid at checkout time.
    expect(pagamentoAprovado.intencao.composicaoValoresAggregate.totalReceiverCents).toBe(
      VALOR_APOS_ALTERACAO_CENTS,
    );
  });
});
