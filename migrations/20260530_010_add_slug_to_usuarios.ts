import type { Kysely } from 'kysely';

/**
 * Add `slug` column to `usuarios` (aperture-khbow).
 *
 * Public URL-segment slug for the parameterized `/painel/[slug]` route.
 * Composite UNIQUE `(id_plataforma, slug)` mirrors the email composite —
 * the same slug can live on eunenem AND eucasei without colliding.
 *
 * Backfill strategy:
 *   1. Add the column NULLABLE so the ALTER doesn't fail on existing rows.
 *   2. Stream existing usuarios and compute a slug for each in JS — same
 *      derivation as `deriveSlugBase` (first hyphen-segment of a
 *      diacritic-stripped lowercase nomeExibicao) + suffix-walk to
 *      resolve any in-plataforma collisions in the existing dataset.
 *   3. UPDATE each row.
 *   4. ALTER COLUMN SET NOT NULL.
 *   5. ADD CONSTRAINT usuarios_plataforma_slug_uniq UNIQUE (id_plataforma, slug)
 *      — name matched verbatim by `UsuarioRepositoryPostgres` so unique-violation
 *      maps to the typed `UsuarioSlugJaExisteError`.
 *
 * Why backfill in JS and not in SQL: Postgres's diacritic handling without
 * the `unaccent` extension is awkward (`translate(…, 'áéí…', 'aei…')` works
 * but is fragile + locale-dependent). The dataset is small (the auth chain
 * just shipped) so a one-shot Node loop is the simpler, more correct path.
 * `unaccent` is also not guaranteed present on every dev / staging DB.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Add NULL-allowing column so the ALTER succeeds on existing data.
  // biome-ignore lint/suspicious/noExplicitAny: Kysely<unknown> doesn't know the
  // post-migration schema — `slug` is added by this migration. We cast for the
  // backfill UPDATE only; the `addColumn` call above is the source of truth.
  const typed = db as Kysely<any>;

  await typed.schema
    .alterTable('usuarios')
    .addColumn('slug', 'varchar(30)') // nullable for backfill
    .execute();

  // 2. Backfill — derive slug from nome_exibicao, suffix-walk to resolve
  // collisions within each plataforma in the existing dataset.
  const rows = await typed
    .selectFrom('usuarios')
    .select(['id', 'id_plataforma', 'nome_exibicao'])
    .execute();

  /** Tracks slugs already assigned per plataforma during this backfill. */
  const takenByPlataforma = new Map<string, Set<string>>();

  for (const row of rows) {
    const base = deriveSlugBaseForBackfill(row.nome_exibicao);
    const taken = takenByPlataforma.get(row.id_plataforma) ?? new Set<string>();
    const slug = walkUniqueForBackfill(base, taken);
    taken.add(slug);
    takenByPlataforma.set(row.id_plataforma, taken);

    await typed.updateTable('usuarios').set({ slug }).where('id', '=', row.id).execute();
  }

  // 3. SET NOT NULL after every existing row has a value.
  await typed.schema
    .alterTable('usuarios')
    .alterColumn('slug', (col) => col.setNotNull())
    .execute();

  // 4. Composite UNIQUE — name matched verbatim by the postgres adapter.
  await typed.schema
    .alterTable('usuarios')
    .addUniqueConstraint('usuarios_plataforma_slug_uniq', ['id_plataforma', 'slug'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: see up()
  const typed = db as Kysely<any>;
  await typed.schema
    .alterTable('usuarios')
    .dropConstraint('usuarios_plataforma_slug_uniq')
    .execute();
  await typed.schema.alterTable('usuarios').dropColumn('slug').execute();
}

// --- Backfill helpers (intentionally duplicated from
//     src/domain/usuario/slug-derivation.ts) ---
//
// Migrations should be self-contained — if we imported the domain helper
// directly and someone later changed the algorithm, replaying this
// migration against a fresh DB could produce different slugs than the
// original run. Copy-pasting freezes the behaviour at migration-author
// time, which is what we want for replay determinism.

const SLUG_REGEX = /^[a-z][a-z0-9-]{2,29}$/;

function deriveSlugBaseForBackfill(nomeExibicao: string): string {
  const stripped = nomeExibicao.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const sanitised = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const firstSegment = sanitised.split('-')[0] ?? '';
  const truncated = firstSegment.slice(0, 30);
  if (SLUG_REGEX.test(truncated)) return truncated;
  return 'usuario';
}

function walkUniqueForBackfill(base: string, taken: Set<string>): string {
  for (let attempt = 1; attempt <= 50; attempt++) {
    const candidate = attempt <= 1 ? base : suffixedForBackfill(base, attempt);
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`migration 010: could not resolve unique slug for base "${base}" in 50 attempts`);
}

function suffixedForBackfill(base: string, attempt: number): string {
  const suffix = `-${attempt}`;
  const maxBaseLen = 30 - suffix.length;
  const trimmedBase = base.slice(0, maxBaseLen).replace(/-+$/g, '');
  if (!/^[a-z]/.test(trimmedBase)) return `usuario${suffix}`;
  return `${trimmedBase}${suffix}`;
}
