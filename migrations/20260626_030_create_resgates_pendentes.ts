import type { Kysely } from 'kysely';

/**
 * ResgatesPendentes — "resgate pendente" intent marker (aperture-kj9el #4b).
 *
 * When a user clicks "preencher depois / estou fazendo para um amigo" on the
 * bank-account (resgate) form, we record a PENDING-INTENT marker WITHOUT
 * storing any bank data, so the frontend can show a pending state + remind
 * the user to complete it. Completing the bank data later CLEARS the marker.
 *
 * WHY a separate table (not a partial `dados_recebimento_usuario` row): that
 * table (migration 028) carries a variant CHECK requiring
 * `metodo IN ('pix','conta')` NOT NULL + full bank columns — a partial /
 * all-null row is IMPOSSIBLE. The pending intent is therefore stored on its
 * own.
 *
 * 1:1 with `usuarios`: `id_usuario` is the PRIMARY KEY with an FK to
 * `usuarios.id` ON DELETE CASCADE — same parent-link pattern as
 * `dados_recebimento_usuario` (028) and `perfil_criadores` (026). Greenfield:
 * no production data exists.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('resgates_pendentes')
    .addColumn('id_usuario', 'uuid', (col) =>
      col.primaryKey().references('usuarios.id').onDelete('cascade'),
    )
    .addColumn('pendente_desde', 'timestamptz', (col) => col.notNull())
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('resgates_pendentes').execute();
}
