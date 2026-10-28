import { type Kysely, sql } from 'kysely';

/** Soft-delete administrativo: remove dos cálculos, preserva cadastro/vigências. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE despesas_manuais
    ADD COLUMN excluida_em timestamptz,
    ADD COLUMN excluida_por uuid,
    ADD CONSTRAINT despesas_manuais_exclusao_par CHECK ((excluida_em IS NULL) = (excluida_por IS NULL))`.execute(
    db,
  );
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE despesas_manuais DROP CONSTRAINT despesas_manuais_exclusao_par,
    DROP COLUMN excluida_em, DROP COLUMN excluida_por`.execute(db);
}
