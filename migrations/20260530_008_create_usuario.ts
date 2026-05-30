import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Usuario BC — domain tables (aperture-xyhjr).
 *
 * Greenfield: no production data exists for these tables; the in-memory
 * adapter has been the only impl until now.
 *
 * Tables:
 *   - `usuarios`: identity record of an admin, scoped to one plataforma.
 *     **Composite UNIQUE (id_plataforma, email)** — preserves the domain
 *     rule per operator decision #2: the same person can register on
 *     eunenem AND eucasei as two separate `usuarios` rows. NOT a global
 *     email unique. The constraint name `usuarios_plataforma_email_uniq`
 *     is matched verbatim by `UsuarioRepositoryPostgres` to surface
 *     `UsuarioEmailJaExisteError`.
 *   - `contas`: 1:1 with usuarios, carries permissoes (text[]).
 *
 * NO BetterAuth tables here — those land in aperture-g7f68 as a separate
 * migration alongside the BetterAuth integration. The two id-spaces are
 * linked by id (engine `usuarios.id` == BetterAuth `user.id`), not by FK.
 *
 * **No cross-BC FK** between Arrecadação's `campanha_administradores.id_usuario`
 * and `usuarios.id` — kept as soft UUID link per recon §2. Adding the FK
 * is a separate decision (would require Usuario to land BEFORE any campanha
 * with administradores, which is true today but locks the order forever).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('usuarios')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_plataforma', 'uuid', (col) => col.notNull())
    .addColumn('id_conta', 'uuid', (col) => col.notNull().unique())
    .addColumn('email', 'varchar(320)', (col) => col.notNull())
    .addColumn('nome_exibicao', 'varchar(120)', (col) => col.notNull())
    .addColumn('criado_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('usuarios_plataforma_email_uniq', ['id_plataforma', 'email'])
    .execute();

  // Lookup index by (id_plataforma, email) is already covered by the
  // UNIQUE constraint above. Add an explicit index on email alone for
  // future cross-tenant audits, but only if cardinality justifies — skip
  // for now (no consumer reads by email-without-plataforma).

  await db.schema
    .createTable('contas')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('id_usuario', 'uuid', (col) =>
      col.notNull().unique().references('usuarios.id').onDelete('cascade'),
    )
    .addColumn('permissoes', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('criada_em', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('contas').execute();
  await db.schema.dropTable('usuarios').execute();
}
