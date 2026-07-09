import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * PerfilCampanha — per-campanha profile table + campanhas.slug (aperture-aphk8, W1a).
 *
 * 1:1 with `campanhas`: `id_campanha` is UNIQUE with an FK to `campanhas.id`
 * ON DELETE CASCADE — the same parent-link pattern `perfil_criadores.id_usuario`
 * uses (migration 20260623_026). One profile row per Campanha; deleting the
 * Campanha cleans up its profile.
 *
 * Column-for-column mirror of `perfil_criadores` content (minus the identity
 * link): the profile moves from "per creator" to "per campanha" so a conta
 * with multiple listas can present a different baby per lista. CHECK
 * constraints copied verbatim from `perfil_criadores_tipo_evento_check` and
 * `perfil_criadores_genero_check` so the DB refuses any value the domain
 * can't read.
 *
 * `campanhas.slug` — the campanha's own URL segment (varchar(60), nullable).
 * Plain NON-unique index only: uniqueness is PER-CONTA and APP-enforced
 * (campanhas-router definirSlug), NOT a DB constraint — two different contas
 * may legitimately hold the same campanha slug.
 *
 * BACKFILL (same migration, after create): every existing campanha gets a
 * perfil_campanhas row copying its owner's perfil_criadores content. Owner =
 * the campanha's first admin conta via campanha_administradores (column
 * `id_usuario` stores the CONTA id) → the conta's usuario via `usuarios`
 * (usuarios.id_conta) → that usuario's perfil_criadores row. Campanhas whose
 * owner has NO perfil_criadores row still get a row, with all-NULL content.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('perfil_campanhas')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_campanha', 'uuid', (col) =>
      col.notNull().unique().references('campanhas.id').onDelete('cascade'),
    )
    .addColumn('nome_bebe', 'varchar(120)')
    .addColumn('relacao', 'varchar(60)')
    .addColumn('historia', 'varchar(600)')
    .addColumn('data_nascimento', 'timestamptz')
    .addColumn('tipo_evento', 'varchar(20)')
    .addColumn('data_evento', 'timestamptz')
    .addColumn('genero', 'varchar(20)')
    .addColumn('foto_perfil_key', 'varchar(512)')
    .addColumn('foto_capa_key', 'varchar(512)')
    .addColumn('foto_historia_key', 'varchar(512)')
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('atualizado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint(
      'perfil_campanhas_tipo_evento_check',
      sql`tipo_evento IS NULL OR tipo_evento IN ('cha-bebe', 'cha-fraldas', 'cha-surpresa', 'cha-revelacao', 'batizado', 'aniversario')`,
    )
    .addCheckConstraint(
      'perfil_campanhas_genero_check',
      sql`genero IS NULL OR genero IN ('menino', 'menina', 'neutro', 'surpresa')`,
    )
    .execute();

  await db.schema.alterTable('campanhas').addColumn('slug', 'varchar(60)').execute();

  // Plain (non-unique) index — per-conta uniqueness is app-enforced.
  await db.schema.createIndex('campanhas_slug_idx').on('campanhas').column('slug').execute();

  // Backfill: one perfil_campanhas row per existing campanha, copying the
  // owner's perfil_criadores content. LEFT JOINs keep campanhas with no
  // admin / no usuario / no perfil — those get an all-NULL content row.
  // "First admin" is deterministic via ORDER BY id_usuario (the join table
  // carries no timestamp; today every campanha has exactly one admin).
  await sql`
    INSERT INTO perfil_campanhas (
      id, id_campanha,
      nome_bebe, relacao, historia, data_nascimento,
      tipo_evento, data_evento, genero,
      foto_perfil_key, foto_capa_key, foto_historia_key,
      criado_em, atualizado_em
    )
    SELECT
      gen_random_uuid(), c.id,
      pc.nome_bebe, pc.relacao, pc.historia, pc.data_nascimento,
      pc.tipo_evento, pc.data_evento, pc.genero,
      pc.foto_perfil_key, pc.foto_capa_key, pc.foto_historia_key,
      now(), now()
    FROM campanhas c
    LEFT JOIN LATERAL (
      SELECT ca.id_usuario AS id_conta
      FROM campanha_administradores ca
      WHERE ca.campanha_id = c.id
      ORDER BY ca.id_usuario ASC
      LIMIT 1
    ) adm ON TRUE
    LEFT JOIN LATERAL (
      -- usuarios has NO unique constraint on id_conta (a conta may hold one
      -- usuario per plataforma) — a plain JOIN here could fan out to multiple
      -- rows per campanha and abort the INSERT on UNIQUE(id_campanha).
      -- LIMIT 1 guarantees one row; the INNER JOIN inside prefers a usuario
      -- that actually HAS a perfil, so a perfil-less sibling can't shadow it.
      SELECT pc.nome_bebe, pc.relacao, pc.historia, pc.data_nascimento,
             pc.tipo_evento, pc.data_evento, pc.genero,
             pc.foto_perfil_key, pc.foto_capa_key, pc.foto_historia_key
      FROM usuarios u
      JOIN perfil_criadores pc ON pc.id_usuario = u.id
      WHERE u.id_conta = adm.id_conta
      ORDER BY pc.criado_em ASC, pc.id ASC
      LIMIT 1
    ) pc ON TRUE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('perfil_campanhas').execute();
  await db.schema.dropIndex('campanhas_slug_idx').execute();
  await db.schema.alterTable('campanhas').dropColumn('slug').execute();
}
