/**
 * Codegen drift check — verifies committed db-types.generated.ts matches live schema.
 *
 * Spins up a Testcontainers Postgres, runs migrations, generates types to a temp file,
 * and diffs against the committed file. Exits non-zero if they differ.
 */

import { execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Migration } from 'kysely';
import { Kysely, Migrator, PostgresDialect } from 'kysely';
import pg from 'pg';

const committedPath = join(import.meta.dirname, '..', 'src', 'adapters', 'db-types.generated.ts');
const migrationFolder = join(import.meta.dirname, '..', 'migrations');
const tmpDir = join(import.meta.dirname, '..', 'tmp');
const tmpPath = join(import.meta.dirname, '..', 'tmp', 'db-types.drift-check.ts');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function isPostgresTerminationError(error: Error): boolean {
  return (error as { code?: unknown }).code === '57P01';
}

async function loadMigrations(): Promise<Record<string, Migration>> {
  const migrations: Record<string, Migration> = {};
  const fileNames = await fs.readdir(migrationFolder);

  for (const fileName of [...fileNames].sort()) {
    const extension = path.extname(fileName);
    if (!['.js', '.mjs', '.ts', '.mts'].includes(extension)) {
      continue;
    }

    const migrationPath = join(migrationFolder, fileName);
    const migration = (await import(pathToFileURL(migrationPath).href)) as Migration;
    migrations[path.basename(fileName, extension)] = migration;
  }

  return migrations;
}

console.log('🔍 Starting codegen drift check...');

// 1. Start Testcontainers Postgres
const container = await new PostgreSqlContainer('postgres:16')
  .withDatabase('frame')
  .withUsername('frame')
  .withPassword('frame')
  .start();

const connectionUrl = container.getConnectionUri();
console.log(`   Postgres container started at ${connectionUrl}`);

const pool = new pg.Pool({ connectionString: connectionUrl });

pool.on('error', (error) => {
  if (isPostgresTerminationError(error)) {
    return;
  }

  throw error;
});

const db = new Kysely({
  dialect: new PostgresDialect({ pool }),
});

try {
  // 2. Run migrations
  const migrator = new Migrator({
    db,
    provider: { getMigrations: loadMigrations },
  });

  const { error } = await migrator.migrateToLatest();
  if (error) {
    throw new Error(`Migration failed: ${error}`);
  }
  console.log('   Migrations applied.');

  // 3. Generate types to temp file
  await fs.mkdir(tmpDir, { recursive: true });
  execFileSync(
    pnpmCommand,
    ['exec', 'kysely-codegen', '--url', connectionUrl, '--out-file', tmpPath],
    {
      shell: process.platform === 'win32',
      stdio: 'pipe',
    },
  );
  console.log('   Types generated to temp file.');

  // 4. Compare
  const committed = readFileSync(committedPath, 'utf-8').trim();
  const generated = readFileSync(tmpPath, 'utf-8').trim();

  if (committed !== generated) {
    console.error('');
    console.error('❌ Codegen drift detected!');
    console.error('   The committed db-types.generated.ts does not match the live schema.');
    console.error('   Run `pnpm db:codegen` and commit the result.');
    console.error('');
    process.exitCode = 1;
  } else {
    console.log('✅ No codegen drift. Committed types match live schema.');
  }
} finally {
  // Cleanup
  await db.destroy();
  await fs.rm(tmpPath, { force: true });
  await container.stop();
}
