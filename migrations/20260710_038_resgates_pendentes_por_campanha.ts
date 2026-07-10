import type { Kysely } from 'kysely';

/**
 * `resgates_pendentes` moves from 1:1-with-usuario to 1:1-with-campanha.
 *
 * "Solicitar transferência" receiving data is now a per-campanha concept
 * (see the recebedor-per-campanha unification), so the "preencher depois /
 * é para um amigo" pending-intent marker follows the same campanha scoping —
 * a user administering multiple campanhas can defer bank data independently
 * per campanha.
 *
 * Greenfield: no production data exists (same rationale as the original
 * migration 030 comment) — DROP + recreate rather than an ALTER dance.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('resgates_pendentes').execute();

  await db.schema
    .createTable('resgates_pendentes')
    .addColumn('id_campanha', 'uuid', (col) =>
      col.primaryKey().references('campanhas.id').onDelete('cascade'),
    )
    .addColumn('pendente_desde', 'timestamptz', (col) => col.notNull())
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('resgates_pendentes').execute();

  await db.schema
    .createTable('resgates_pendentes')
    .addColumn('id_usuario', 'uuid', (col) =>
      col.primaryKey().references('usuarios.id').onDelete('cascade'),
    )
    .addColumn('pendente_desde', 'timestamptz', (col) => col.notNull())
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull())
    .execute();
}
