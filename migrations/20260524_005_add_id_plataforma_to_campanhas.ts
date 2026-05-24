import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Multi-tenant: cada campanha pertence a exatamente uma plataforma.
 *
 * - Adiciona coluna `id_plataforma` em `campanhas` (UUID, nullable temporariamente).
 * - Backfill: associa todas as campanhas existentes a `eunenem`
 *   (UUID seed `11111111-1111-4111-8111-111111111111`).
 * - Promove a coluna para NOT NULL.
 * - Cria index para a query `findByPlataforma`.
 *
 * Não há FK: a Plataforma BC é memory-only no momento, então a validação
 * existencial vive na use case (`criarCampanha` injeta `plataformaRepository`).
 */

const ID_PLATAFORMA_EUNENEM = '11111111-1111-4111-8111-111111111111';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('campanhas').addColumn('id_plataforma', 'uuid').execute();

  await sql`UPDATE campanhas SET id_plataforma = ${ID_PLATAFORMA_EUNENEM} WHERE id_plataforma IS NULL`.execute(
    db,
  );

  await sql`ALTER TABLE campanhas ALTER COLUMN id_plataforma SET NOT NULL`.execute(db);

  await db.schema
    .createIndex('campanhas_id_plataforma_idx')
    .on('campanhas')
    .column('id_plataforma')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('campanhas_id_plataforma_idx').execute();
  await db.schema.alterTable('campanhas').dropColumn('id_plataforma').execute();
}
