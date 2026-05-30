/**
 * Integration test for fluxo-administracao-campanha.
 *
 * Validates campaign governance across Usuário + Arrecadação contexts:
 * add co-admin, create contribution, remove co-admin,
 * and block removal of the last remaining administrator.
 *
 * Arrecadação persists in Postgres via Testcontainers; Usuário/Plataforma
 * use in-memory adapters.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { AuthServiceMemoria } from '../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { ArrecadacaoUltimoAdministradorError } from '../../src/errors/arrecadacao/ultimo-administrador.error.js';
import { adicionarAdministradorCampanha } from '../../src/use-cases/arrecadacao/adicionar-administrador-campanha.js';
import { adicionarOpcaoContribuicao } from '../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../src/use-cases/arrecadacao/criar-campanha.js';
import { criarContribuicao } from '../../src/use-cases/arrecadacao/criar-contribuicao.js';
import { removerAdministradorCampanha } from '../../src/use-cases/arrecadacao/remover-administrador-campanha.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

const fixedDate = new Date('2026-05-01T12:00:00.000Z');
const clock = () => fixedDate;

const dadosRecebedorPadrao = () => ({
  nomeTitular: 'Maria Silva',
  tipoChavePix: 'email' as const,
  chavePix: 'maria@exemplo.com',
});

function makeDeps() {
  const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
  const campanhaRepository = new CampanhaRepositoryPostgres(testDb.db, recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryPostgres(testDb.db);
  const plataformaRepository = new PlataformaRepositoryMemory();
  const usuarioRepository = new UsuarioRepositoryMemory();
  const observability = testObs.observability;

  return {
    recebedorRepository,
    campanhaRepository,
    contribuicaoRepository,
    plataformaRepository,
    usuarioRepository,
    observability,
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

describe('Fluxo — administração de campanha', () => {
  it('Valida colaboração entre administradores e bloqueio de exclusão do último administrador', async () => {
    const deps = makeDeps();
    const idCampanha = randomUUID();
    const idOpcao = randomUUID();
    const idContribuicao = randomUUID();

    const adminAEmail = 'admin.a@exemplo.com';
    const adminBEmail = 'admin.b@exemplo.com';
    const adminASenha = 'senha-admin-a';

    const { conta: contaA } = await registrarContaUsuario(
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
        email: adminAEmail,
        nomeExibicao: 'Admin A',
        senhaSimulada: adminASenha,
      },
    );

    const { conta: contaB } = await registrarContaUsuario(
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
        email: adminBEmail,
        nomeExibicao: 'Admin B',
        senhaSimulada: 'senha-admin-b',
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
        idsAdministradores: [contaA.id],
        dadosRecebedor: dadosRecebedorPadrao(),
        titulo: 'Campanha Administracao',
      },
    );

    await adicionarOpcaoContribuicao(
      { campanhaRepository: deps.campanhaRepository, observability: deps.observability },
      { idCampanha, idOpcao, tipo: 'presente' },
    );

    const campanhaComB = await adicionarAdministradorCampanha(
      { campanhaRepository: deps.campanhaRepository, observability: deps.observability },
      { idCampanha, idConta: contaB.id },
    );
    expect(campanhaComB.idsAdministradores).toEqual([contaA.id, contaB.id]);

    const campanhaReloadComB = await deps.campanhaRepository.findById(idCampanha);
    expect(campanhaReloadComB?.idsAdministradores).toEqual([contaA.id, contaB.id]);

    const contribuicaoCriada = await criarContribuicao(
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
        nome: 'Cesta de cafe da manha',
        valor: 6000,
      },
    );

    expect(contribuicaoCriada.status).toBe('disponivel');
    const contribuicaoReload = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoReload?.id).toBe(idContribuicao);
    expect(contribuicaoReload?.status).toBe('disponivel');

    const campanhaSemB = await removerAdministradorCampanha(
      { campanhaRepository: deps.campanhaRepository, observability: deps.observability },
      { idCampanha, idConta: contaB.id },
    );
    expect(campanhaSemB.idsAdministradores).toEqual([contaA.id]);

    const campanhaReloadSemB = await deps.campanhaRepository.findById(idCampanha);
    expect(campanhaReloadSemB?.idsAdministradores).toEqual([contaA.id]);

    const contribuicaoAposRemocaoB = await deps.contribuicaoRepository.findById(idContribuicao);
    expect(contribuicaoAposRemocaoB?.id).toBe(idContribuicao);

    await expect(
      removerAdministradorCampanha(
        { campanhaRepository: deps.campanhaRepository, observability: deps.observability },
        { idCampanha, idConta: contaA.id },
      ),
    ).rejects.toThrow(ArrecadacaoUltimoAdministradorError);

    const campanhaFinal = await deps.campanhaRepository.findById(idCampanha);
    expect(campanhaFinal?.idsAdministradores).toEqual([contaA.id]);
  });
});
