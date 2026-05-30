/**
 * Integration test for fluxo-exclusividade-contribuicao (fluxo 4).
 *
 * Validates contribution exclusivity in Arrecadação when two visitors attempt
 * checkout on the same item: visitor A reserves the contribution in Postgres,
 * visitor B's checkout fails, and no second pending payment is created.
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
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { ProvedorRegraTaxaMemory } from '../../src/adapters/taxas/regra-provider.memory.js';
import { AuthServiceMemoria } from '../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { ArrecadacaoContribuicaoNaoDisponivelError } from '../../src/errors/arrecadacao/contribuicao-nao-disponivel.error.js';
import { adicionarOpcaoContribuicao } from '../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { iniciarPagamentoContribuicao } from '../../src/use-cases/checkout/iniciar-pagamento-contribuicao.js';
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

const contribuinteVisitanteA = () => ({
  nome: 'Visitante A',
  email: 'visitante.a@exemplo.com',
});

const contribuinteVisitanteB = () => ({
  nome: 'Visitante B',
  email: 'visitante.b@exemplo.com',
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
  it('reserva a contribuição para visitante A e rejeita checkout do visitante B', async () => {
    const {
      deps,
      idCampanha,
      idContribuicao,
      idPagamentoA,
      idPagamentoB,
      idIntencaoA,
      idIntencaoB,
    } = await seedFluxoBase();

    const contribuicaoInicial = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoInicial?.status).toBe('disponivel');
    expect(contribuicaoInicial?.contribuinte).toBeNull();

    const checkoutDeps = {
      campanhaRepository: deps.campanhaRepository,
      contribuicaoRepository: deps.contribuicaoRepository,
      provedorRegraTaxa: deps.provedorRegraTaxa,
      pagamentoRepository: deps.pagamentoRepository,
      pagamentoEventPublisher: deps.pagamentoEventPublisher,
      clock,
      observability: deps.observability,
    };

    const { contribuicao: contribuicaoReservada, pagamento: pagamentoA } =
      await iniciarPagamentoContribuicao(checkoutDeps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idContribuicao,
        contribuinte: contribuinteVisitanteA(),
        metodo: 'pix',
        idPagamento: idPagamentoA,
        idIntencaoPagamento: idIntencaoA,
      });

    expect(contribuicaoReservada.status).toBe('indisponivel');
    expect(contribuicaoReservada.contribuinte).toEqual(contribuinteVisitanteA());
    expect(pagamentoA.status).toBe('pendente');

    const contribuicaoAposCheckoutA = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoAposCheckoutA?.status).toBe('indisponivel');
    expect(contribuicaoAposCheckoutA?.contribuinte).toEqual(contribuinteVisitanteA());

    await expect(
      iniciarPagamentoContribuicao(checkoutDeps, {
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idCampanha,
        idContribuicao,
        contribuinte: contribuinteVisitanteB(),
        metodo: 'pix',
        idPagamento: idPagamentoB,
        idIntencaoPagamento: idIntencaoB,
      }),
    ).rejects.toThrow(ArrecadacaoContribuicaoNaoDisponivelError);

    const contribuicaoFinal = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoFinal?.status).toBe('indisponivel');
    expect(contribuicaoFinal?.contribuinte).toEqual(contribuinteVisitanteA());

    const pagamentoPersistidoA = await deps.pagamentoRepository.findById(idPagamentoA);
    expect(pagamentoPersistidoA?.status).toBe('pendente');

    const pagamentoPersistidoB = await deps.pagamentoRepository.findById(idPagamentoB);
    expect(pagamentoPersistidoB).toBeUndefined();

    const eventos = deps.pagamentoEventPublisher.getEventosPublicados();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.tipo).toBe('payment.intent_created');
    expect(eventos[0]?.idPagamento).toBe(idPagamentoA);
  });
});
