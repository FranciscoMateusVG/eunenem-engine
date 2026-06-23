import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * PerfilCriador — creator public-profile table (aperture-3dlzs).
 *
 * 1:1 with `usuarios`: `id_usuario` is UNIQUE with an FK to `usuarios.id`
 * ON DELETE CASCADE — exactly the parent-link pattern `contas.id_usuario`
 * uses (migration 008). One profile row per Usuario; deleting the Usuario
 * cleans up its profile.
 *
 * Holds only editable profile CONTENT (baby name, relation, story, event
 * dates, event kind, photo storage keys) — NOT identity (slug stays on
 * `usuarios`), NOT receiving/Pix data (R4), NOT photo blobs (R5 stores only
 * the keys here). All content columns are nullable: a profile starts empty
 * and is filled progressively via the painel form.
 *
 * `tipo_evento` carries a CHECK constraint matching the canonical Evento BC
 * vocabulary verbatim (aperture-qk5wi enum-alignment fix) — the DB refuses
 * any celebration slug the rest of the domain can't read.
 *
 * Greenfield: no production data exists for this table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('perfil_criadores')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_usuario', 'uuid', (col) =>
      col.notNull().unique().references('usuarios.id').onDelete('cascade'),
    )
    .addColumn('nome_bebe', 'varchar(120)')
    .addColumn('relacao', 'varchar(60)')
    .addColumn('historia', 'varchar(600)')
    .addColumn('data_nascimento', 'timestamptz')
    .addColumn('tipo_evento', 'varchar(20)')
    .addColumn('data_evento', 'timestamptz')
    .addColumn('foto_perfil_key', 'varchar(512)')
    .addColumn('foto_capa_key', 'varchar(512)')
    .addColumn('foto_historia_key', 'varchar(512)')
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'perfil_criadores_tipo_evento_check',
      sql`tipo_evento IS NULL OR tipo_evento IN ('cha-bebe', 'cha-fraldas', 'cha-surpresa', 'cha-revelacao', 'batizado', 'aniversario')`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('perfil_criadores').execute();
}
