import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CampanhaRepositoryPostgres } from '../../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { makeCampanha } from '../helpers/campanha-repository.conformance.js';
import { createTestObservability } from '../helpers/observability.js';
import { describeRecebedorRepositoryConformance } from '../helpers/recebedor-repository.conformance.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { truncateArrecadacaoTables } from '../helpers/truncate-arrecadacao.js';

let testDb: TestDatabase;
const testObs = createTestObservability();

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60000);

afterAll(async () => {
  await testDb.teardown();
  await testObs.shutdown();
});

describeRecebedorRepositoryConformance('Postgres', {
  factory: () => {
    const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
    const campanhaRepository = new CampanhaRepositoryPostgres(testDb.db, recebedorRepository);
    return { campanhaRepository, recebedorRepository };
  },
  resetState: () => truncateArrecadacaoTables(testDb.db),
  getSpans: () => testObs.getSpans(),
  resetSpans: () => testObs.reset(),
  expectedDbSystem: 'postgresql',
});

describe('CHECK recebedores_endereco_fiscal_completo (aperture-xdylg)', () => {
  const idCampanha = randomUUID();
  beforeAll(async () => {
    const recebedorRepository = new RecebedorRepositoryPostgres(testDb.db);
    await new CampanhaRepositoryPostgres(testDb.db, recebedorRepository).save(
      makeCampanha({ id: idCampanha }),
    );
  });

  const inserir = (endereco: Record<string, string | null>) =>
    sql`INSERT INTO recebedores (id, campanha_id, metodo, nome_titular, cpf_titular, tipo_chave_pix, chave_pix, is_active,
        endereco_cep, endereco_logradouro, endereco_numero, endereco_complemento, endereco_bairro, endereco_cidade,
        endereco_uf, endereco_codigo_municipio_ibge)
      VALUES (${randomUUID()}::uuid, ${idCampanha}::uuid, 'pix', 'Maria', '52998224725', 'email', 'm@e.com', false,
        ${endereco.cep ?? null}, ${endereco.lgr ?? null}, ${endereco.nro ?? null}, ${endereco.cpl ?? null},
        ${endereco.bairro ?? null}, ${endereco.cidade ?? null}, ${endereco.uf ?? null}, ${endereco.ibge ?? null})`.execute(
      testDb.db,
    );
  const completo = {
    cep: '30130010',
    lgr: 'Rua X',
    nro: '1',
    cpl: null,
    bairro: 'Centro',
    cidade: 'BH',
    uf: 'MG',
    ibge: '3106200',
  };

  it('aceita tudo nulo e endereço completo (complemento opcional)', async () => {
    await expect(inserir({})).resolves.toBeDefined();
    await expect(inserir(completo)).resolves.toBeDefined();
  });

  it.each([
    ['sem CEP', { ...completo, cep: null }],
    ['sem IBGE', { ...completo, ibge: null }],
    ['sem CEP e sem IBGE', { ...completo, cep: null, ibge: null }],
    ['sem bairro', { ...completo, bairro: null }],
    ['CEP malformado', { ...completo, cep: '3013001' }],
    ['só o CEP', { cep: '30130010' }],
  ])('recusa endereço parcial: %s', async (_nome, endereco) => {
    await expect(inserir(endereco)).rejects.toThrow(/recebedores_endereco_fiscal_completo/);
  });
});
