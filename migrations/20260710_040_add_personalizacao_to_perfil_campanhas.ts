import type { Kysely } from 'kysely';

/**
 * Add `papais`, `cor_primaria`, `cor_acento` to perfil_campanhas.
 *
 * Persists the TweaksPanel ("Personalizar") fields that had no backing
 * column: the "parents" display line and the two swatch-picked hex colors.
 * All nullable free text/hex — no CHECK vocabulary to pin (unlike
 * genero/tipo_evento), mirrors the shape of
 * `20260628_031_add_genero_to_perfil_criador.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('perfil_campanhas').addColumn('papais', 'varchar(120)').execute();
  await db.schema.alterTable('perfil_campanhas').addColumn('cor_primaria', 'varchar(20)').execute();
  await db.schema.alterTable('perfil_campanhas').addColumn('cor_acento', 'varchar(20)').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('perfil_campanhas').dropColumn('cor_acento').execute();
  await db.schema.alterTable('perfil_campanhas').dropColumn('cor_primaria').execute();
  await db.schema.alterTable('perfil_campanhas').dropColumn('papais').execute();
}
