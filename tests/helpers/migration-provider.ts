import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Migration, MigrationProvider } from 'kysely';

const migrationFolder = path.join(import.meta.dirname, '..', '..', 'migrations');

export function createMigrationProvider(): MigrationProvider {
  return {
    async getMigrations(): Promise<Record<string, Migration>> {
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
    },
  };
}
