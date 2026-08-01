import type { Kysely } from 'kysely';

/**
 * aperture-zy4uo: adiciona a assinatura opcional do convite — a linha de
 * fechamento editavel pelo usuario (ex.: "Com carinho, os pais"). Nullable e
 * sem default porque convites existentes nao tem assinatura e ausencia
 * significa "nao definida".
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('convites').addColumn('assinatura', 'varchar(200)').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('convites').dropColumn('assinatura').execute();
}
