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

    // Migrate down (latest migration first). aperture-xaha2 added the
    // pagamentos migration (011) on top of slug (010), better-auth (009),
    // and usuario (008).
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
