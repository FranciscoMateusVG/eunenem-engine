import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Paginated browse indexes for `usuarios` (aperture-qatwz).
 *
 * Supports `UsuarioRepository.findUsuariosPaginated`, which is the new
 * browse-as-default surface on /admin (cursor-paginated table). The port
 * supports three sort columns — `criadoEm`, `email`, `nomeExibicao` — each
 * with `(sortColumn, id)` tuple-comparison cursors for tie-break stability.
 *
 * Index coverage:
 *   - `usuarios_plataforma_criado_em_id_idx` covers sort by criadoEm (DESC
 *     default). The DESC declaration on both columns lets Postgres avoid
 *     a backward scan on the natural query direction; ASC queries still
 *     use the same index via reverse scan.
 *   - `usuarios_plataforma_nome_id_idx` covers sort by nome_exibicao.
 *     ASC-only by default; reverse scan handles DESC.
 *   - Sort by `email` REUSES the existing `usuarios_plataforma_email_uniq`
 *     UNIQUE constraint index — composite (id_plataforma, email) where
 *     email is unique within tenant, so the tie-break on `id` is
 *     unnecessary (no two rows share the same email under the constraint).
 *     No new index needed for email.
 *
 * The tenant prefix (id_plataforma) on each index lets Postgres restrict
 * the scan to one tenant at the index-only level — important because every
 * query is tenant-scoped.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX usuarios_plataforma_criado_em_id_idx
      ON usuarios (id_plataforma, criado_em DESC, id DESC)
  `.execute(db);

  await sql`
    CREATE INDEX usuarios_plataforma_nome_id_idx
      ON usuarios (id_plataforma, nome_exibicao, id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS usuarios_plataforma_nome_id_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS usuarios_plataforma_criado_em_id_idx`.execute(db);
}
