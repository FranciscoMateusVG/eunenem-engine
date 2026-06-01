import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, Migrator, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigrationProvider } from '../helpers/migration-provider.js';

describe('Migration round-trip', () => {
  let container: StartedPostgreSqlContainer;
  let db: Kysely<unknown>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('frame')
      .withUsername('frame')
      .withPassword('frame')
      .start();

    db = new Kysely({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: container.getConnectionUri() }),
      }),
    });
  }, 60000);

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it('should migrate up and down cleanly', async () => {
    const migrator = new Migrator({
      db,
      provider: createMigrationProvider(),
    });

    // Migrate up
    const upResult = await migrator.migrateToLatest();
    expect(upResult.error).toBeUndefined();
    expect(upResult.results).toBeDefined();
    expect(upResult.results?.every((r) => r.status === 'Success')).toBe(true);

    // Verify cats table exists
    const tables = await db
      .selectFrom('information_schema.tables' as never)
      .select('table_name' as never)
      .where('table_schema' as never, '=', 'public' as never)
      .execute();
    const tableNames = tables.map((t: Record<string, unknown>) => t.table_name);
    expect(tableNames).toContain('cats');
    expect(tableNames).toContain('campanhas');
    expect(tableNames).toContain('recebedores');
    expect(tableNames).toContain('usuarios');
    expect(tableNames).toContain('contas');
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('accounts');
    expect(tableNames).toContain('verifications');
    expect(tableNames).toContain('rate_limit');
    expect(tableNames).toContain('pagamentos');
    // aperture-id3ay added the financeiro migration (012).
    expect(tableNames).toContain('lancamentos_financeiros');
    expect(tableNames).toContain('repasses_recebedor');

    // aperture-qatwz added two paginated-browse indexes on usuarios (013).
    // Verify the indexes exist (no new tables here — pure index migration).
    const indexes = await db
      .selectFrom('pg_indexes' as never)
      .select('indexname' as never)
      .where('schemaname' as never, '=', 'public' as never)
      .where('tablename' as never, '=', 'usuarios' as never)
      .execute();
    const indexNames = indexes.map((i: Record<string, unknown>) => i.indexname);
    expect(indexNames).toContain('usuarios_plataforma_criado_em_id_idx');
    expect(indexNames).toContain('usuarios_plataforma_nome_id_idx');

    // Migrate down (latest migration first). aperture-qatwz added the
    // paginated-indexes migration (013) on top of financeiro (012),
    // pagamentos (011), slug (010), better-auth (009), and usuario (008).
    const downPaginatedIndexes = await migrator.migrateDown();
    expect(downPaginatedIndexes.error).toBeUndefined();

    // After down on 013, both indexes should be gone.
    const indexesAfterDown = await db
      .selectFrom('pg_indexes' as never)
      .select('indexname' as never)
      .where('schemaname' as never, '=', 'public' as never)
      .where('tablename' as never, '=', 'usuarios' as never)
      .execute();
    const namesAfterDown = indexesAfterDown.map((i: Record<string, unknown>) => i.indexname);
    expect(namesAfterDown).not.toContain('usuarios_plataforma_criado_em_id_idx');
    expect(namesAfterDown).not.toContain('usuarios_plataforma_nome_id_idx');

    const downFinanceiro = await migrator.migrateDown();
    expect(downFinanceiro.error).toBeUndefined();

    const downPagamentos = await migrator.migrateDown();
    expect(downPagamentos.error).toBeUndefined();

    const downSlug = await migrator.migrateDown();
    expect(downSlug.error).toBeUndefined();

    const downBetterAuth = await migrator.migrateDown();
    expect(downBetterAuth.error).toBeUndefined();

    const downUsuario = await migrator.migrateDown();
    expect(downUsuario.error).toBeUndefined();

    const downGrupoContribuicoes = await migrator.migrateDown();
    expect(downGrupoContribuicoes.error).toBeUndefined();

    const downImagemUrlContribuicoes = await migrator.migrateDown();
    expect(downImagemUrlContribuicoes.error).toBeUndefined();

    const downCampanhasIdPlataforma = await migrator.migrateDown();
    expect(downCampanhasIdPlataforma.error).toBeUndefined();

    const downRecebedoresIdCarteira = await migrator.migrateDown();
    expect(downRecebedoresIdCarteira.error).toBeUndefined();

    const downRecebedores = await migrator.migrateDown();
    expect(downRecebedores.error).toBeUndefined();

    const downArrecadacaoAlter = await migrator.migrateDown();
    expect(downArrecadacaoAlter.error).toBeUndefined();

    const downArrecadacaoCreate = await migrator.migrateDown();
    expect(downArrecadacaoCreate.error).toBeUndefined();

    const tablesAfterArrecadacao = await db
      .selectFrom('information_schema.tables' as never)
      .select('table_name' as never)
      .where('table_schema' as never, '=', 'public' as never)
      .execute();
    const namesAfterArrecadacao = tablesAfterArrecadacao.map(
      (t: Record<string, unknown>) => t.table_name,
    );
    expect(namesAfterArrecadacao).not.toContain('campanhas');
    expect(namesAfterArrecadacao).toContain('cats');

    const downCats = await migrator.migrateDown();
    expect(downCats.error).toBeUndefined();

    const tablesAfterCats = await db
      .selectFrom('information_schema.tables' as never)
      .select('table_name' as never)
      .where('table_schema' as never, '=', 'public' as never)
      .execute();
    const namesAfterCats = tablesAfterCats.map((t: Record<string, unknown>) => t.table_name);
    expect(namesAfterCats).not.toContain('cats');
  });
});
