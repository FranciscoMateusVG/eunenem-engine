/**
 * Integration test for fluxo-exclusividade-contribuicao (fluxo 4).
 *
 * Validates the "sold out" gate in the checkout saga when two visitors attempt
 * checkout on the same quantidade=1 item. Plan 0015/0016 (aperture-ucgok /
 * aperture-eg1s2) replaced the old claim-based exclusivity FSM with a derived
 * `esgotada` gate: a slot is unavailable once an APROVADO pagamento has sold its
 * full quantidade. Visitor A starts checkout and A's pagamento settles to
 * aprovado → the slot is now esgotada → visitor B's checkout is refused with
 * ArrecadacaoContribuicaoIndisponivelError, and no second pending payment is
 * created. (Locked decision #6: this is a UX gate, not a concurrency lock — two
 * visitors who BOTH pass the gate before either settles can both complete.)
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
import { ArrecadacaoContribuicaoIndisponivelError } from '../../src/errors/arrecadacao/contribuicao-indisponivel.error.js';
import { adicionarOpcaoContribuicao } from '../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
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

const VALOR_CONTRIBUICAO_CENTS = 8000;

const dadosRecebedorPadrao = () => ({
  metodo: 'pix' as const,
  nomeTitular: 'Maria Silva',
  cpfTitular: '52998224725',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
});

const contribuinteVisitanteA = () => ({
  nome: 'Visitante A',
  email: 'visitante.a@exemplo.com',
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
  const idPagamentoA = randomUUID();
  const idPagamentoB = randomUUID();
  const idIntencaoA = randomUUID();
  const idIntencaoB = randomUUID();

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
      titulo: 'Campanha Exclusividade',
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
    idPagamentoA,
    idPagamentoB,
    idIntencaoA,
    idIntencaoB,
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

describe('Fluxo — exclusividade de contribuição entre visitantes', () => {
  it('vende o slot (quantidade=1) para o visitante A e rejeita o checkout do visitante B como esgotado', async () => {
    const {
      deps,
      idCampanha,
      idContribuicao,
      idPagamentoA,
      idPagamentoB,
      idIntencaoA,
      idIntencaoB,
    } = await seedFluxoBase();

    // Plan 0015/0016: Contribuição has no `status` / `contribuinte` fields.
    // Availability is derived via esgotada(); contribuinte lives on the aprovado
    // pagamento's intenção. The freshly-seeded slot is available.
    const esgotadaArgs = {
      pagamentoRepository: deps.pagamentoRepository,
      contribuicaoRepository: deps.contribuicaoRepository,
      observability: deps.observability,
    };
    const contribuicaoInicial = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoInicial?.id).toBe(idContribuicao);
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

    // Plan 0016 (aperture-eg1s2): the saga no longer claims the contribuição at
    // checkout-start. Both visitors could mount a session; the esgotada gate
    // only fires once an APROVADO pagamento has sold the slot's full quantidade.
    const { contribuicoes: contribuicoesAposCheckoutASaga, pagamento: pagamentoA } =
      await iniciarPagamentoCarrinho(checkoutDeps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        itens: [{ idContribuicao, quantidade: 1 }],
        idsItens: [randomUUID()],
        metodo: 'pix',
        idPagamento: idPagamentoA,
        idIntencaoPagamento: idIntencaoA,
        returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
      });

    expect(contribuicoesAposCheckoutASaga[0]?.id).toBe(idContribuicao);
    expect(pagamentoA.intencao.contribuinte).toBeNull();
    expect(pagamentoA.status).toBe('pendente');
    // Still available — the pendente pagamento doesn't count as sold.
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(false);

    // Visitor A's webhook fires → pagamento settles to aprovado → the slot is
    // now sold out (quantidade=1, sold=1 → esgotada). Claim is stamped from the
    // webhook contribuinte inside finalize.
    const { pagamento: pagamentoAprovadoA } = await finalizarPagamentoAprovado(
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
      { idPagamento: idPagamentoA, contribuinte: contribuinteVisitanteA() },
    );
    expect(pagamentoAprovadoA.status).toBe('aprovado');

    // The aprovado pagamento carries the contribuinte and sells out the slot.
    expect(pagamentoAprovadoA.intencao.contribuinte).toEqual(contribuinteVisitanteA());
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(true);

    // Visitor B now attempts to start checkout — refused by the per-item
    // esgotada gate (step 3) because the slot is sold out.
    await expect(
      iniciarPagamentoCarrinho(checkoutDeps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        itens: [{ idContribuicao, quantidade: 1 }],
        idsItens: [randomUUID()],
        metodo: 'pix',
        idPagamento: idPagamentoB,
        idIntencaoPagamento: idIntencaoB,
        returnUrl: 'https://test.example/sucesso?session_id={CHECKOUT_SESSION_ID}',
      }),
    ).rejects.toThrow(ArrecadacaoContribuicaoIndisponivelError);

    // Slot remains sold out and bound to visitor A's contribuinte.
    expect(await esgotada(esgotadaArgs, { idContribuicao })).toBe(true);
    const pagamentoAprovadoReload = await deps.pagamentoRepository.findById(idPagamentoA);
    expect(pagamentoAprovadoReload?.intencao.contribuinte).toEqual(contribuinteVisitanteA());

    const pagamentoPersistidoA = await deps.pagamentoRepository.findById(idPagamentoA);
    expect(pagamentoPersistidoA?.status).toBe('aprovado');

    // Visitor B's pagamento was never created — the saga early-failed before
    // persisting an intenção.
    const pagamentoPersistidoB = await deps.pagamentoRepository.findById(idPagamentoB);
    expect(pagamentoPersistidoB).toBeUndefined();

    // Only visitor A's payment produced events; no intent_created for B.
    const eventos = deps.pagamentoEventPublisher.getEventosPublicados();
    const eventosB = eventos.filter((e) => e.idPagamento === idPagamentoB);
    expect(eventosB).toHaveLength(0);
    const intentCreatedA = eventos.filter(
      (e) => e.idPagamento === idPagamentoA && e.tipo === 'payment.intent_created',
    );
    expect(intentCreatedA).toHaveLength(1);
  });
});
