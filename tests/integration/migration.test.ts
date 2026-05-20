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

    // Migrate down (latest migration first)
    const downArrecadacao = await migrator.migrateDown();
    expect(downArrecadacao.error).toBeUndefined();

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
