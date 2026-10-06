import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Migration } from 'kysely';
import { Kysely, Migrator, PostgresDialect } from 'kysely';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://frame:frame@localhost:54320/frame';
const migrationFolder = path.join(import.meta.dirname, '..', 'migrations');

async function loadMigrations(): Promise<Record<string, Migration>> {
  const migrations: Record<string, Migration> = {};
  const fileNames = await fs.readdir(migrationFolder);

  for (const fileName of [...fileNames].sort()) {
    const extension = path.extname(fileName);
    if (!['.js', '.mjs', '.ts', '.mts'].includes(extension)) {
      continue;
    }

    const migrationPath = path.join(migrationFolder, fileName);
    const migration = (await import(pathToFileURL(migrationPath).href)) as Migration;
    migrations[path.basename(fileName, extension)] = migration;
  }

  return migrations;
}

const db = new Kysely({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: databaseUrl }),
  }),
});

const migrator = new Migrator({
  db,
  provider: { getMigrations: loadMigrations },
  // TEMPORÁRIO (sync main↔staging, aprovado pelo operador em 2026-10-05):
  // staging aplicou 20260925_055_add_desativado_em_to_usuarios antes de
  // 20260913_055 e 20260916_056, que prod já tem. Desligar assim que os dois
  // bancos tiverem todas as migrations — enquanto ligado, a trava de ordem do
  // CI (1bo61) também fica desligada.
  allowUnorderedMigrations: true,
});

const { error, results } = await migrator.migrateToLatest();

for (const result of results ?? []) {
  if (result.status === 'Success') {
    console.log(`✅ Migration "${result.migrationName}" applied successfully.`);
  } else if (result.status === 'Error') {
    console.error(`❌ Migration "${result.migrationName}" failed.`);
  }
}

if (error) {
  console.error('Migration failed:', error);
  await db.destroy();
  process.exit(1);
}

console.log('✅ All migrations applied.');
await db.destroy();
