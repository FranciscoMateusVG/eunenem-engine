/**
 * Integration test for the p8i01 one-shot backfill script.
 *
 * Validates that `backfillCampanhasParaUsuariosExistentes`:
 *   1. Creates a default Campanha + 'presente' OpcaoContribuicao for every
 *      usuario lacking one — and is idempotent when re-run.
 *   2. Skips usuarios that already own a campanha (the production case for
 *      anyone who signed up post-p8i01).
 *   3. Mixes the two correctly on a heterogeneous user set.
 *
 * Postgres comes from Testcontainers; the Usuario aggregate is seeded via
 * `UsuarioRepositoryPostgres.saveRegistroDomain` (the same write-path the
 * signup saga uses), so the FK landscape matches prod.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backfillCampanhasParaUsuariosExistentes } from '../../scripts/p8i01-backfill-campanhas.js';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import type { Conta, Usuario } from '../../src/domain/usuario/entities/usuario.js';
import { PERMISSOES_PADRAO } from '../../src/domain/usuario/value-objects/permissao.js';
import { adicionarOpcaoContribuicao } from '../../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../../src/use-cases/arrecadacao/criar-campanha.js';
import { createTestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';
import { truncateUsuarioTables } from '../helpers/truncate-usuario.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

const fixedDate = new Date('2026-05-30T12:00:00.000Z');
const clock = () => fixedDate;

function makeDeps() {
  const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
  const campanhaRepository = new CampanhaRepositoryPostgres(testDb.db, recebedorRepository);
  const plataformaRepository = new PlataformaRepositoryMemory();
  const usuarioRepository = new UsuarioRepositoryPostgres(testDb.db);
  return {
    db: testDb.db,
    recebedorRepository,
    campanhaRepository,
    plataformaRepository,
    usuarioRepository,
    observability: testObs.observability,
    clock,
  };
}

async function seedUsuario(
  usuarioRepository: UsuarioRepositoryPostgres,
  nomeExibicao: string,
  slug: string,
): Promise<{ usuario: Usuario; conta: Conta }> {
  const idUsuario = randomUUID();
  const idConta = randomUUID();
  const usuario: Usuario = {
    id: idUsuario,
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    idConta,
    email: `${slug}@exemplo.com`,
    nomeExibicao,
    slug,
    criadoEm: fixedDate,
  };
  const conta: Conta = {
    id: idConta,
    idUsuario,
    permissoes: PERMISSOES_PADRAO,
    criadaEm: fixedDate,
  };
  await usuarioRepository.saveRegistroDomain({ usuario, conta });
  return { usuario, conta };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

beforeEach(async () => {
  await truncateArrecadacaoTables(testDb.db);
  await truncateUsuarioTables(testDb.db);
  testObs.reset();
});

describe('p8i01 backfill — campanhas para usuarios pré-saga', () => {
  it('cria campanha + opcao para usuarios sem campanha e é idempotente', async () => {
    const deps = makeDeps();

    await seedUsuario(deps.usuarioRepository, 'Usuario Um', 'usuario-um');
    await seedUsuario(deps.usuarioRepository, 'Usuario Dois', 'usuario-dois');

    const primeira = await backfillCampanhasParaUsuariosExistentes(deps);
    expect(primeira).toEqual({ total: 2, criadas: 2, skipped: 0, erros: 0 });

    const campanhasApos1 = await testDb.db.selectFrom('campanhas').selectAll().execute();
    expect(campanhasApos1).toHaveLength(2);
    expect(campanhasApos1.map((c) => c.titulo).sort()).toEqual([
      'Lista de Usuario Dois',
      'Lista de Usuario Um',
    ]);

    const opcoesApos1 = await testDb.db.selectFrom('opcoes_contribuicao').selectAll().execute();
    expect(opcoesApos1).toHaveLength(2);
    expect(opcoesApos1.every((o) => o.tipo === 'presente')).toBe(true);

    // Re-run: must be a no-op.
    const segunda = await backfillCampanhasParaUsuariosExistentes(deps);
    expect(segunda).toEqual({ total: 2, criadas: 0, skipped: 2, erros: 0 });

    const campanhasApos2 = await testDb.db.selectFrom('campanhas').selectAll().execute();
    expect(campanhasApos2).toHaveLength(2);
    const opcoesApos2 = await testDb.db.selectFrom('opcoes_contribuicao').selectAll().execute();
    expect(opcoesApos2).toHaveLength(2);
  });

  it('pula usuario que já tem campanha pré-existente', async () => {
    const deps = makeDeps();
    const { conta } = await seedUsuario(deps.usuarioRepository, 'Ja Tem', 'ja-tem');

    // Pre-create a campanha for this user out-of-band — mimics the
    // post-p8i01 signup case where the saga already created one.
    const idCampanhaPreExistente = randomUUID();
    await criarCampanha(
      {
        campanhaRepository: deps.campanhaRepository,
        recebedorRepository: deps.recebedorRepository,
        plataformaRepository: deps.plataformaRepository,
        clock,
        observability: deps.observability,
      },
      {
        id: idCampanhaPreExistente,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idsAdministradores: [conta.id],
        titulo: 'Lista pré-existente',
      },
    );
    await adicionarOpcaoContribuicao(
      { campanhaRepository: deps.campanhaRepository, observability: deps.observability },
      { idCampanha: idCampanhaPreExistente, idOpcao: randomUUID(), tipo: 'presente' },
    );

    const result = await backfillCampanhasParaUsuariosExistentes(deps);
    expect(result).toEqual({ total: 1, criadas: 0, skipped: 1, erros: 0 });

    const campanhas = await testDb.db.selectFrom('campanhas').selectAll().execute();
    expect(campanhas).toHaveLength(1);
    expect(campanhas[0]?.id).toBe(idCampanhaPreExistente);

    const opcoes = await testDb.db.selectFrom('opcoes_contribuicao').selectAll().execute();
    expect(opcoes).toHaveLength(1);
  });

  it('mistura criação e skip no mesmo run', async () => {
    const deps = makeDeps();
    const { conta: contaComCampanha } = await seedUsuario(
      deps.usuarioRepository,
      'Tem Campanha',
      'tem-campanha',
    );
    await seedUsuario(deps.usuarioRepository, 'Sem Um', 'sem-um');
    await seedUsuario(deps.usuarioRepository, 'Sem Dois', 'sem-dois');

    // Give the first user a campanha so the backfill must skip them.
    const idCampanhaPre = randomUUID();
    await criarCampanha(
      {
        campanhaRepository: deps.campanhaRepository,
        recebedorRepository: deps.recebedorRepository,
        plataformaRepository: deps.plataformaRepository,
        clock,
        observability: deps.observability,
      },
      {
        id: idCampanhaPre,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        idsAdministradores: [contaComCampanha.id],
        titulo: 'Lista de Tem Campanha',
      },
    );

    const result = await backfillCampanhasParaUsuariosExistentes(deps);
    expect(result).toEqual({ total: 3, criadas: 2, skipped: 1, erros: 0 });

    const campanhas = await testDb.db.selectFrom('campanhas').selectAll().execute();
    expect(campanhas).toHaveLength(3);
    expect(campanhas.map((c) => c.titulo).sort()).toEqual([
      'Lista de Sem Dois',
      'Lista de Sem Um',
      'Lista de Tem Campanha',
    ]);

    const opcoes = await testDb.db.selectFrom('opcoes_contribuicao').selectAll().execute();
    // 2 created here + 0 added to the pre-existing one (we didn't seed an opcao for it).
    expect(opcoes).toHaveLength(2);
    expect(opcoes.every((o) => o.tipo === 'presente')).toBe(true);
  });
});
