import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Add `genero` to perfil_criadores (aperture-neiwx / 29kho-C).
 *
 * The baby's gender, used to drive PT-BR pronoun/article agreement on the
 * guest profile + owner painel greetings from a single source. Nullable —
 * existing rows (and profiles created before the onboarding step captures it)
 * stay null, which the frontend renders with neutral phrasing.
 *
 * CHECK constraint mirrors the GeneroBebe VO vocabulary verbatim (same
 * convention as `perfil_criadores_tipo_evento_check`) so the DB refuses any
 * value the domain can't read.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('perfil_criadores').addColumn('genero', 'varchar(20)').execute();

  await db.schema
    .alterTable('perfil_criadores')
    .addCheckConstraint(
      'perfil_criadores_genero_check',
      sql`genero IS NULL OR genero IN ('menino', 'menina', 'neutro', 'surpresa')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('perfil_criadores')
    .dropConstraint('perfil_criadores_genero_check')
    .execute();

  await db.schema.alterTable('perfil_criadores').dropColumn('genero').execute();
}
