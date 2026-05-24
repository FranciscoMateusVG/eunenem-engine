import type { Kysely } from 'kysely';

/**
 * Adiciona uma URL de imagem opcional para cada contribuição. Útil para a
 * loja exibir um thumbnail do item. Nullable porque contribuições já
 * existentes podem não ter imagem, e nem toda contribuição precisa de uma.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('contribuicoes').addColumn('imagem_url', 'text').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('contribuicoes').dropColumn('imagem_url').execute();
}
