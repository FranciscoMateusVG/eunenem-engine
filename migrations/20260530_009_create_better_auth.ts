import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * BetterAuth tables (aperture-g7f68) — Pattern A from recon
 * aperture-q2i8l §5. Five tables that match BetterAuth's canonical
 * schema, snake_case columns so the engine + BetterAuth's HTTP runtime
 * (mounted by consumers via `auth.handler` in child 4) read/write the
 * same rows.
 *
 * Schema source: `@better-auth/core/dist/db/schema/{user,session,account,
 * verification,rate-limit}.d.mts`. Hand-ported to Kysely per recon §8 #7
 * (CLI emits raw SQL only).
 *
 * Tables:
 *   - `users`            — BetterAuth user + engine `id_plataforma`
 *                          additionalField (required, preserves operator
 *                          decision #2 composite uniqueness alongside the
 *                          domain `usuarios` table from aperture-xyhjr —
 *                          BetterAuth's `users.id` == engine `usuarios.id`)
 *   - `sessions`         — token-keyed sessions
 *   - `accounts`         — credential rows (email/password = `provider_id:'credential'`)
 *   - `verifications`    — email verification, password reset tokens
 *   - `rate_limit`       — BetterAuth's database-mode rate-limit storage
 *                          (operator decision #4 — NOT in-memory; survives
 *                          multi-instance deploys)
 *
 * **`users.email` is NOT globally unique.** Composite uniqueness
 * `(id_plataforma, email)` enforced via `users_plataforma_email_uniq` so
 * the same person can sign up on eunenem AND eucasei with the same
 * email — preserves operator decision #2 in lockstep with the
 * `usuarios_plataforma_email_uniq` constraint on the engine-domain
 * table.
 *
 * IDs are stored as `varchar(36)` (matches BetterAuth's string `id` type;
 * works with any id generator — UUID, ULID, nanoid). Engine-side
 * `AuthServiceBetterAuth.criarConta` supplies caller-controlled UUIDs
 * for users; sessions/accounts/verifications get their own UUIDs from
 * the adapter at write time.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    .addColumn('email', 'varchar(320)', (col) => col.notNull())
    .addColumn('email_verified', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('image', 'text')
    .addColumn('id_plataforma', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('users_plataforma_email_uniq', ['id_plataforma', 'email'])
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('token', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('ip_address', 'varchar(45)')
    .addColumn('user_agent', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema.createIndex('sessions_user_id_idx').on('sessions').column('user_id').execute();

  await db.schema
    .createTable('accounts')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('provider_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('account_id', 'varchar(320)', (col) => col.notNull())
    .addColumn('password', 'text')
    .addColumn('access_token', 'text')
    .addColumn('refresh_token', 'text')
    .addColumn('id_token', 'text')
    .addColumn('access_token_expires_at', 'timestamptz')
    .addColumn('refresh_token_expires_at', 'timestamptz')
    .addColumn('scope', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('accounts_provider_account_uniq', ['provider_id', 'account_id'])
    .execute();

  await db.schema.createIndex('accounts_user_id_idx').on('accounts').column('user_id').execute();

  await db.schema
    .createTable('verifications')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('identifier', 'varchar(320)', (col) => col.notNull())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('verifications_identifier_idx')
    .on('verifications')
    .column('identifier')
    .execute();

  await db.schema
    .createTable('rate_limit')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('key', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_request', 'bigint', (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('rate_limit').execute();
  await db.schema.dropTable('verifications').execute();
  await db.schema.dropTable('accounts').execute();
  await db.schema.dropTable('sessions').execute();
  await db.schema.dropTable('users').execute();
}
