import type { Kysely } from 'kysely';
import { sql } from 'kysely';

const CONVITES_FONTE_CHECK = sql`
  fonte IN (
    'patrick',
    'caveat',
    'dancing-script',
    'shadows-into-light',
    'handlee'
  )
`;

const CONVITES_FONTE_CHECK_PREVIOUS = sql`
  fonte IN ('patrick', 'caveat')
`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('convites').dropConstraint('convites_fonte_check').execute();

  await db.schema
    .alterTable('convites')
    .addCheckConstraint('convites_fonte_check', CONVITES_FONTE_CHECK)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('convites').dropConstraint('convites_fonte_check').execute();

  await db.schema
    .alterTable('convites')
    .addCheckConstraint('convites_fonte_check', CONVITES_FONTE_CHECK_PREVIOUS)
    .execute();
}
