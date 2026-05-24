import type { Kysely } from 'kysely';

/**
 * Agrupamento opcional para contribuições. Útil para a loja organizar itens
 * dentro de uma opção (ex: "vestuário" dentro de `presente`). Sem
 * semântica de domínio — campo é puramente organizacional.
 *
 * Nullable porque nem toda opção se beneficia de grupos (rifa, por
 * exemplo), e admins não são forçados a categorizar.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('contribuicoes').addColumn('grupo', 'varchar(60)').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('contribuicoes').dropColumn('grupo').execute();
}
